import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRunner } from "../packages/tools/src/docker-runner.js";
import { filterEnv } from "../packages/tools/src/command-policy.js";

// Adversarial tests against the REAL container boundary. They are skipped when
// no Docker daemon / image is available (e.g. the Windows CI leg). Image: any
// image with node + a POSIX sh; CI uses the sandbox image from docker/sandbox.
const IMAGE = process.env.TEST_DOCKER_IMAGE ?? "node:22-alpine";
const available = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const hasGit = available && spawnSync("docker", ["run", "--rm", "--network=none", IMAGE, "git", "--version"], { stdio: "ignore" }).status === 0;

const runner = new DockerRunner({ image: IMAGE, user: "10001:10001", memory: "256m", cpus: "1", pids: 64 });
const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "kw-dock-"));
  chmodSync(dir, 0o777);
  dirs.push(dir);
  return dir;
}

function run(cwd: string, command: string[], timeoutMs = 20_000, maxBytes = 65_536) {
  return runner.exec({ workspaceId: "w", command, cwd, env: filterEnv(), timeoutMs, maxBytes });
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("docker sandbox", () => {
  it("runs as the unprivileged user in /work and writes through to the workspace", async () => {
    const cwd = workspace();
    const result = await run(cwd, ["sh", "-c", "id -u; pwd; echo hi > out.txt"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").slice(0, 2)).toEqual(["10001", "/work"]);
    expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("hi\n");
  }, 30_000);

  it("has no network", async () => {
    const cwd = workspace();
    const script = "require('net').connect(80,'1.1.1.1').on('error',e=>{console.log('ERR '+e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)})";
    const result = await run(cwd, ["node", "-e", script], 15_000);
    expect(result.stdout).not.toContain("CONNECTED");
    expect(result.stdout).toMatch(/ERR (ENETUNREACH|EAI_AGAIN|EADDRNOTAVAIL)/);
  }, 30_000);

  it("cannot see the host filesystem outside the workspace", async () => {
    const cwd = workspace();
    const secretDir = mkdtempSync(join(tmpdir(), "kw-host-secret-"));
    dirs.push(secretDir);
    writeFileSync(join(secretDir, "secret.txt"), "HOST-ONLY");
    const result = await run(cwd, ["sh", "-c", `cat ${secretDir}/secret.txt; ls /home /root 2>&1; ls /var/run/docker.sock 2>&1`]);
    expect(result.stdout + result.stderr).not.toContain("HOST-ONLY");
    expect(result.stdout + result.stderr).toMatch(/No such file|can't open|cannot access|Permission denied/);
  }, 30_000);

  it("has a read-only root filesystem and no host environment", async () => {
    const cwd = workspace();
    process.env.KW_HOST_SECRET_PROBE = "leak-me";
    try {
      const write = await run(cwd, ["sh", "-c", "echo x > /usr/pwned 2>&1"]);
      expect(write.exitCode).not.toBe(0);
      const env = await run(cwd, ["sh", "-c", "env"]);
      expect(env.stdout).not.toContain("leak-me");
      expect(env.stdout).toContain("HOME=/tmp");
    } finally {
      delete process.env.KW_HOST_SECRET_PROBE;
    }
  }, 30_000);

  it("drops all capabilities and cannot gain privileges", async () => {
    const cwd = workspace();
    const result = await run(cwd, ["sh", "-c", "grep -E 'CapEff|NoNewPrivs' /proc/self/status"]);
    expect(result.stdout).toMatch(/CapEff:\s*0000000000000000/);
    expect(result.stdout).toMatch(/NoNewPrivs:\s*1/);
  }, 30_000);

  it("caps process count (fork bomb cannot take the host)", async () => {
    const cwd = workspace();
    const result = await run(cwd, ["sh", "-c", "for i in $(seq 1 300); do sleep 20 & done; wait"], 15_000);
    expect(result.stderr).toMatch(/can't fork|Resource temporarily unavailable|Cannot fork/i);
  }, 40_000);

  it("kills the container on timeout (no leftovers)", async () => {
    const cwd = workspace();
    const result = await run(cwd, ["sh", "-c", "while true; do sleep 1; done"], 1_500);
    expect(result.timedOut).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const left = spawnSync("docker", ["ps", "-q", "--filter", "name=kw-tex_"], { encoding: "utf8" });
    expect(left.stdout.trim()).toBe("");
  }, 40_000);

  it("kills a live execution by id", async () => {
    const cwd = workspace();
    const running = run(cwd, ["sh", "-c", "while true; do sleep 1; done"], 60_000);
    await new Promise((r) => setTimeout(r, 1500));
    const live = runner.liveInWorkspace("w");
    expect(live.length).toBe(1);
    expect(runner.kill(live[0] as string)).toBe(true);
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(runner.liveCount).toBe(0);
    expect(runner.kill("tex_does_not_exist")).toBe(false);
  }, 60_000);

  it("caps output", async () => {
    const cwd = workspace();
    const result = await run(cwd, ["sh", "-c", "yes AAAAAAAA | head -c 200000"], 15_000, 1024);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  }, 30_000);

  it("fails closed, never running on the host, when docker cannot run", async () => {
    const broken = new DockerRunner({ image: "kw-image-that-does-not-exist:0", user: "10001:10001", memory: "64m", cpus: "1", pids: 32 });
    const marker = join(workspace(), "host-ran.txt");
    const result = await broken.exec({
      workspaceId: "w",
      command: ["sh", "-c", `echo x > ${marker}`],
      cwd: join(marker, ".."),
      env: filterEnv(),
      timeoutMs: 20_000,
      maxBytes: 4096,
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 40_000);

  it("refuses to run as root when the workspace is root-owned and no user is configured", async () => {
    if (process.getuid?.() !== 0) return;
    const auto = new DockerRunner({ image: IMAGE, user: "", memory: "64m", cpus: "1", pids: 32 });
    const result = await auto.exec({ workspaceId: "w", command: ["id"], cwd: workspace(), env: filterEnv(), timeoutMs: 10_000, maxBytes: 4096 });
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/owned by root/);
  }, 30_000);

  it.skipIf(!hasGit)("runs git on the mounted workspace despite the uid mismatch", async () => {
    const cwd = workspace();
    const init = await run(cwd, ["git", "init", "-q"]);
    expect(init.exitCode).toBe(0);
    const status = await run(cwd, ["git", "status", "--porcelain"]);
    expect(status.exitCode).toBe(0);
  }, 30_000);
});
