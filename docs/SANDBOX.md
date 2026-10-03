# Agent command sandbox

`EXEC_SANDBOX=docker` runs every agent command (`terminal.exec`, all `git.*`) in
a throwaway container. **This container is the security boundary.** The command
policy (`command-policy.ts`) only reduces approval noise and is not a sandbox.

## What the container gets
- no network (`--network=none`), read-only root, `--cap-drop=ALL`, `no-new-privileges`
- non-root numeric user, pids / memory / cpu limits, 64 MB `/tmp` tmpfs
- the workspace directory only, mounted read-write at `/work`
- no host environment (secrets stay out), no Docker socket, no host paths

## Setup
```bash
docker build -t kingworld-sandbox:1 docker/sandbox
# .env
EXEC_SANDBOX=docker
EXEC_DOCKER_USER=10001:10001   # or empty = owner of the workspace dir (never root)
```
`EXEC_SANDBOX` defaults to `docker` when `NODE_ENV=production` and to `local` otherwise.
The workspace directory must be writable by that uid. The server **refuses to
start** if Docker or the image is missing, and never falls back to the host.

## Known limits
- No network means no `npm install` / `git clone` / `git push` inside the sandbox.
  Phase 3 (network policy) is not built.
- A container does not stop an agent from leaking workspace data through the
  output of its own commands; that needs a separate policy.
- Never mount the Docker socket into anything the agent can reach.
- `local` (the default outside production) is for development and tests only. Forcing
  `EXEC_SANDBOX=local` in production is allowed but logs a warning at boot.
