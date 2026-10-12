/**
 * Skill store: durable state for the external skills ecosystem.
 *
 * The database is the single source of truth for the catalog, agent
 * assignments, usage counters and agent skill requests. There is no
 * in-memory copy to drift, so state survives restarts, a second API
 * instance sees the same data, and "restoring at boot" is simply reading
 * the tables. EventLog + ActivityLog remain the audit trail of every change.
 *
 * Integrity rules:
 *  - a write is reported as done only after the database accepted it; any
 *    failure propagates (the route answers 5xx, nothing is half-applied in
 *    memory);
 *  - a catalog row whose JSON is unreadable is never silently replaced:
 *    `get` fails loudly, `list` skips and logs it;
 *  - assignments are unique per (skill, agent) and usage counters only ever
 *    move by atomic increments, so retries and concurrency cannot duplicate.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma, withTransaction, type DbClient } from "../../../../packages/database/src/index.js";
import { internalError, logger } from "../../../../packages/shared/src/index.js";
import {
  AgentWorldProvider,
  GitHubProvider,
  LocalProvider,
  ProviderRegistry,
  SkillStatusSchema,
  SkillsShProvider,
  blankCounters,
  searchCatalogRecords,
  type CatalogFilter,
  type ExternalSkillListing,
  type SkillCatalogRecord,
  type SkillRequest,
  type SkillUsageCounters,
} from "../../../../packages/skills/src/index.js";

const log = logger.child({ component: "api.skill-store" });

const BUILTIN_LISTINGS: ExternalSkillListing[] = [
  {
    externalId: "planning",
    name: "Planning",
    description: "Decomposes objectives into tasks, milestones, and acceptance criteria.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "planning",
    source: { type: "AGENTWORLD", identifier: "planning", version: "1.0.0" },
  },
  {
    externalId: "research",
    name: "Research",
    description: "Gathers information from the world, memory, and documents.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "research",
    source: { type: "AGENTWORLD", identifier: "research", version: "1.0.0" },
  },
  {
    externalId: "software",
    name: "Software",
    description: "Builds and modifies software artefacts.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "coding",
    source: { type: "AGENTWORLD", identifier: "software", version: "1.0.0" },
  },
  {
    externalId: "testing",
    name: "Testing",
    description: "Designs and runs verification of produced work.",
    version: "1.0.0",
    author: "AgentWorld",
    category: "testing",
    source: { type: "AGENTWORLD", identifier: "testing", version: "1.0.0" },
  },
];

export const skillProviders = new ProviderRegistry()
  .register(new AgentWorldProvider(BUILTIN_LISTINGS))
  .register(new SkillsShProvider())
  .register(new GitHubProvider())
  .register(new LocalProvider());

/** Counter columns a usage event may increment. */
export type SkillUsageEvent =
  | { kind: "installation" }
  | { kind: "update" }
  | { kind: "rollback" }
  | { kind: "permissionDenial" }
  | { kind: "securityBlock" }
  | { kind: "execution"; success: boolean; durationMs: number; agentId?: string };

const MAX_SKILL_KEY = 120;

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_SKILL_KEY) {
    throw new Error("Invalid skill key");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Shape check of a stored record; a row that fails it is corrupt. */
function parseRecord(key: string, raw: string): SkillCatalogRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<SkillCatalogRecord> | null;
    if (value === null || typeof value !== "object") return null;
    if (value.key !== key || typeof value.name !== "string") return null;
    if (!SkillStatusSchema.safeParse(value.status).success) return null;
    if (typeof value.source !== "object" || value.source === null) return null;
    if (!Array.isArray(value.versionHistory) || !Array.isArray(value.grantedPermissions)) return null;
    return value as SkillCatalogRecord;
  } catch {
    return null;
  }
}

function toRequest(row: {
  id: string;
  skillKey: string;
  agentId: string;
  reason: string;
  status: string;
  decidedByUserId: string | null;
  createdAt: Date;
}): SkillRequest {
  return {
    id: row.id,
    skillKey: row.skillKey,
    agentId: row.agentId,
    reason: row.reason,
    status: row.status as SkillRequest["status"],
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class SkillStore {
  constructor(private readonly db: PrismaClient) {}

  // -- Catalog ---------------------------------------------------------------

  async get(key: string): Promise<SkillCatalogRecord | undefined> {
    const row = await this.db.skillCatalogEntry.findUnique({ where: { key } });
    if (row === null) return undefined;
    const record = parseRecord(row.key, row.record);
    if (record === null) {
      log.error("Stored skill record is corrupt", { action: "skill.store.corrupt", skillKey: row.key });
      throw internalError("Stored skill record is unreadable");
    }
    return record;
  }

  async list(): Promise<SkillCatalogRecord[]> {
    const rows = await this.db.skillCatalogEntry.findMany({ orderBy: { key: "asc" } });
    const records: SkillCatalogRecord[] = [];
    for (const row of rows) {
      const record = parseRecord(row.key, row.record);
      if (record === null) {
        log.error("Skipping corrupt stored skill record", { action: "skill.store.corrupt", skillKey: row.key });
        continue;
      }
      records.push(record);
    }
    return records;
  }

  async search(filter: CatalogFilter = {}): Promise<SkillCatalogRecord[]> {
    return searchCatalogRecords(await this.list(), filter);
  }

  /** Persists a record (insert or replace). Resolves only once committed. */
  async save(record: SkillCatalogRecord, db: DbClient = this.db): Promise<SkillCatalogRecord> {
    assertKey(record.key);
    if (!SkillStatusSchema.safeParse(record.status).success) throw new Error("Invalid skill status");
    const data = { record: JSON.stringify(record), status: record.status, installed: record.installed };
    await db.skillCatalogEntry.upsert({
      where: { key: record.key },
      create: { key: record.key, ...data },
      update: data,
    });
    return record;
  }

  /** Saves a record and bumps one usage counter atomically (one transaction). */
  async saveWithUsage(record: SkillCatalogRecord, event: SkillUsageEvent): Promise<SkillCatalogRecord> {
    await withTransaction(this.db, async (tx) => {
      await this.save(record, tx);
      await this.recordUsage(record.key, event, tx);
    });
    return record;
  }

  /** Removes a skill and (via FK cascade) its assignments. Usage history is kept. */
  async remove(key: string): Promise<boolean> {
    const deleted = await this.db.skillCatalogEntry.deleteMany({ where: { key } });
    return deleted.count > 0;
  }

  // -- Assignments -------------------------------------------------------------

  /** Idempotent: true when a new assignment was created, false if it existed. */
  async assign(skillKey: string, agentId: string): Promise<boolean> {
    try {
      await this.db.skillAssignment.create({ data: { skillKey, agentId } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async agentsForSkill(skillKey: string): Promise<string[]> {
    const rows = await this.db.skillAssignment.findMany({
      where: { skillKey },
      select: { agentId: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => row.agentId);
  }

  // -- Usage ------------------------------------------------------------------

  async recordUsage(skillKey: string, event: SkillUsageEvent, db: DbClient = this.db): Promise<void> {
    assertKey(skillKey);
    const increments: Partial<Record<keyof Omit<SkillUsageCounters, "agents">, number>> = {};
    switch (event.kind) {
      case "installation":
        increments.installations = 1;
        break;
      case "update":
        increments.updates = 1;
        break;
      case "rollback":
        increments.rollbacks = 1;
        break;
      case "permissionDenial":
        increments.permissionDenials = 1;
        break;
      case "securityBlock":
        increments.securityBlocks = 1;
        break;
      case "execution": {
        increments.executions = 1;
        if (event.success) increments.success = 1;
        else increments.failure = 1;
        const duration = Number.isFinite(event.durationMs) ? Math.max(0, Math.floor(event.durationMs)) : 0;
        increments.totalDurationMs = duration;
        break;
      }
    }
    const update = Object.fromEntries(Object.entries(increments).map(([field, by]) => [field, { increment: by }]));
    const upsert = (): Promise<unknown> =>
      db.skillUsage.upsert({ where: { skillKey }, create: { skillKey, ...increments }, update });
    try {
      await upsert();
    } catch (error) {
      // Two first-ever events can race on the insert; the loser retries as an update.
      if (!isUniqueViolation(error)) throw error;
      await upsert();
    }
    if (event.kind === "execution" && event.agentId !== undefined) {
      try {
        await db.skillUsageAgent.create({ data: { skillKey, agentId: event.agentId } });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  async usage(skillKey: string): Promise<SkillUsageCounters> {
    const [row, agents] = await Promise.all([
      this.db.skillUsage.findUnique({ where: { skillKey } }),
      this.db.skillUsageAgent.findMany({ where: { skillKey }, select: { agentId: true }, orderBy: { createdAt: "asc" } }),
    ]);
    const counters = blankCounters();
    if (row !== null) {
      counters.installations = row.installations;
      counters.executions = row.executions;
      counters.success = row.success;
      counters.failure = row.failure;
      counters.totalDurationMs = row.totalDurationMs;
      counters.permissionDenials = row.permissionDenials;
      counters.securityBlocks = row.securityBlocks;
      counters.updates = row.updates;
      counters.rollbacks = row.rollbacks;
    }
    counters.agents = agents.map((entry) => entry.agentId);
    return counters;
  }

  // -- Agent skill requests ------------------------------------------------------

  async createRequest(input: { skillKey: string; agentId: string; reason: string }): Promise<SkillRequest> {
    const row = await this.db.skillRequest.create({ data: { ...input, status: "PENDING" } });
    return toRequest(row);
  }

  async getRequest(id: string): Promise<SkillRequest | undefined> {
    const row = await this.db.skillRequest.findUnique({ where: { id } });
    return row === null ? undefined : toRequest(row);
  }

  /**
   * Persists a decision only if the request is still PENDING (compare-and-
   * set), so two concurrent deciders cannot both win. False = already decided.
   */
  async saveDecision(decided: SkillRequest): Promise<boolean> {
    const result = await this.db.skillRequest.updateMany({
      where: { id: decided.id, status: "PENDING" },
      data: { status: decided.status, decidedByUserId: decided.decidedByUserId, decidedAt: new Date() },
    });
    return result.count === 1;
  }
}

/** Process-wide store bound to the application database client. */
export const skillStore = new SkillStore(prisma);
