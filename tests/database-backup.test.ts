import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../packages/database/src/client.js";
import { backupDatabase, defaultBackupPath } from "../packages/database/src/backup.js";
import { createTestUser } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "agentworld-backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("database backup", () => {
  it("writes a standalone copy that holds the same rows", async () => {
    await createTestUser();
    const live = await prisma.user.count();
    const file = await backupDatabase(prisma, join(dir, "nested", "copy.db"));

    const copy = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
    try {
      expect(await copy.user.count()).toBe(live);
    } finally {
      await copy.$disconnect();
    }
  });

  it("refuses to overwrite an existing backup", async () => {
    const existing = join(dir, "existing.db");
    writeFileSync(existing, "precious");
    await expect(backupDatabase(prisma, existing)).rejects.toThrow(/Refusing to overwrite/);
  });

  it("handles a quote in the target path", async () => {
    const file = await backupDatabase(prisma, join(dir, "it's here.db"));
    expect(file.endsWith("it's here.db")).toBe(true);
  });

  it("names backups with a Windows-safe timestamp", () => {
    expect(defaultBackupPath(new Date("2026-10-11T12:00:00.000Z"))).toBe(
      "backups/agentworld-2026-10-11T12-00-00-000Z.db",
    );
  });
});
