/**
 * Response mappers. Never leak provider secrets, password hashes, or raw
 * internal payloads. Every route returns through these.
 */
import { fromJson, toJsonArray } from "../../../../packages/shared/src/index.js";

interface WithJson {
  personality?: string;
  goals?: string;
  skills?: string;
  capabilities?: string;
  metadata?: string;
  actionPayload?: string;
  arguments?: string;
}

function parseArray(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return toJsonArray(raw);
}

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  return fromJson<Record<string, unknown>>(raw, {});
}

export function toSafeUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toAgentDto(agent: Record<string, unknown>): Record<string, unknown> {
  const raw = agent as WithJson & Record<string, unknown>;
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    roleKey: raw.roleKey,
    title: raw.title,
    systemPrompt: raw.systemPrompt,
    personality: typeof raw.personality === "string" ? parseObject(raw.personality) : (raw.personality ?? {}),
    goals: typeof raw.goals === "string" ? parseArray(raw.goals) : (raw.goals ?? []),
    skills: typeof raw.skills === "string" ? parseArray(raw.skills) : (raw.skills ?? []),
    capabilities: typeof raw.capabilities === "string" ? parseArray(raw.capabilities) : (raw.capabilities ?? []),
    providerId: raw.providerId,
    model: raw.model,
    temperature: raw.temperature,
    maxTokens: raw.maxTokens,
    worldId: raw.worldId ?? null,
    currentLocationId: raw.currentLocationId ?? null,
    currentCompanyId: raw.currentCompanyId ?? null,
    currentJob: raw.currentJob ?? null,
    reputation: raw.reputation,
    isActive: raw.isActive,
    createdAt: (raw.createdAt as Date)?.toISOString?.() ?? raw.createdAt,
    updatedAt: (raw.updatedAt as Date)?.toISOString?.() ?? raw.updatedAt,
  };
}

export function toTaskDto(task: Record<string, unknown>): Record<string, unknown> {
  const raw = task as WithJson & Record<string, unknown>;
  return {
    ...raw,
    metadata: typeof raw.metadata === "string" ? parseObject(raw.metadata) : (raw.metadata ?? {}),
    createdAt: (raw.createdAt as Date)?.toISOString?.() ?? raw.createdAt,
    updatedAt: (raw.updatedAt as Date)?.toISOString?.() ?? raw.updatedAt,
  };
}

export function toApprovalDto(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row as WithJson & Record<string, unknown>;
  return {
    ...raw,
    actionPayload: typeof raw.actionPayload === "string" ? parseObject(raw.actionPayload) : raw.actionPayload,
    createdAt: (raw.createdAt as Date)?.toISOString?.() ?? raw.createdAt,
    updatedAt: (raw.updatedAt as Date)?.toISOString?.() ?? raw.updatedAt,
    expiresAt: (raw.expiresAt as Date | null)?.toISOString?.() ?? null,
    decidedAt: (raw.decidedAt as Date | null)?.toISOString?.() ?? null,
    executedAt: (raw.executedAt as Date | null)?.toISOString?.() ?? null,
  };
}

export function toMessageDto(message: Record<string, unknown>): Record<string, unknown> {
  const raw = message as WithJson & Record<string, unknown>;
  return {
    ...raw,
    metadata: typeof raw.metadata === "string" ? parseObject(raw.metadata) : (raw.metadata ?? {}),
    createdAt: (raw.createdAt as Date)?.toISOString?.() ?? raw.createdAt,
  };
}

export function paginated<T>(items: T[], total: number, page: number, pageSize: number): Record<string, unknown> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
