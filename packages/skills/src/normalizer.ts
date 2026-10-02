/**
 * Normalizer: external format -> AgentWorld SkillManifest.
 *
 * Never assume the external format matches ours. Every provider funnels
 * through `normalizeExternalSkill` before validation. Unknown fields are
 * dropped; missing required fields become explicit validation errors;
 * permission/tool/capability hints are harvested from several likely
 * locations (frontmatter, manifest keys, tags) so nothing is silently lost.
 */
import { SkillManifestSchema, type SkillManifest } from "./types.js";
import type { SkillSource } from "./sources.js";

interface NormalizableInput {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  author?: unknown;
  publisher?: unknown;
  license?: unknown;
  repository?: unknown;
  repo?: unknown;
  category?: unknown;
  capabilities?: unknown;
  permissions?: unknown;
  tools?: unknown;
  dependencies?: unknown;
  secretRequirements?: unknown;
  secrets?: unknown;
  network?: unknown;
  instructions?: unknown;
  content?: unknown;
  skillContent?: unknown;
  files?: unknown;
  runtime?: unknown;
  tags?: unknown;
  metadata?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") out.push(entry.trim());
    else if (typeof entry === "object" && entry !== null) {
      const maybe = entry as { key?: unknown; name?: unknown };
      const named = asString(maybe.key) ?? asString(maybe.name);
      if (named !== undefined) out.push(named);
    }
  }
  return out;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "external-skill";
}

function parseDependencies(value: unknown): Array<{ key: string; versionRange?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ key: string; versionRange?: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      out.push({ key: entry.trim().slice(0, 120) });
    } else if (typeof entry === "object" && entry !== null) {
      const obj = entry as { key?: unknown; name?: unknown; versionRange?: unknown; version?: unknown };
      const key = asString(obj.key) ?? asString(obj.name);
      if (key === undefined) continue;
      const range = asString(obj.versionRange) ?? asString(obj.version);
      out.push(range === undefined ? { key } : { key, versionRange: range });
    }
  }
  return out;
}

function parseNetwork(value: unknown): { access: boolean; domains: string[] } {
  if (typeof value === "boolean") return { access: value, domains: [] };
  if (typeof value === "object" && value !== null) {
    const obj = value as { access?: unknown; domains?: unknown; allowlist?: unknown };
    const access = obj.access === true;
    const domains = asStringArray(obj.domains).concat(asStringArray(obj.allowlist));
    return { access, domains: [...new Set(domains)].slice(0, 50) };
  }
  return { access: false, domains: [] };
}

function parseFiles(value: unknown): Array<{ path: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ path: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") out.push({ path: entry.trim().slice(0, 500) });
    else if (typeof entry === "object" && entry !== null) {
      const obj = entry as { path?: unknown; name?: unknown };
      const p = asString(obj.path) ?? asString(obj.name);
      if (p !== undefined) out.push({ path: p.slice(0, 500) });
    }
  }
  return out;
}

/**
 * Normalize an untrusted external payload into a SkillManifest candidate.
 * Throws (ZodError) when required fields are missing or malformed.
 */
export function normalizeExternalSkill(raw: unknown, fallback: { externalId: string; source: SkillSource }): SkillManifest {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as NormalizableInput;
  const nested = (typeof input.metadata === "object" && input.metadata !== null
    ? input.metadata as NormalizableInput
    : {}) as NormalizableInput;

  const pick = (primary: unknown, secondary: unknown): unknown =>
    primary !== undefined ? primary : secondary;

  const keyRaw = asString(input.key) ?? slugify(asString(input.name) ?? fallback.externalId);
  const instructions =
    asString(input.instructions) ?? asString(input.content) ?? asString(input.skillContent) ?? "";

  const candidate = {
    key: slugify(keyRaw),
    name: asString(input.name) ?? fallback.externalId.slice(0, 200),
    description: asString(input.description) ?? asString(nested.description) ?? `External skill ${fallback.externalId}`,
    version: asString(input.version) ?? asString(nested.version) ?? fallback.source.version ?? "0.0.0",
    author: asString(input.author) ?? asString(nested.author),
    publisher: asString(input.publisher) ?? undefined,
    license: asString(input.license) ?? asString(nested.license),
    repository: asString(input.repository) ?? asString(input.repo) ?? undefined,
    category: asString(input.category) ?? undefined,
    capabilities: asStringArray(pick(input.capabilities, nested.capabilities)),
    permissions: asStringArray(pick(input.permissions, nested.permissions)),
    tools: asStringArray(pick(input.tools, nested.tools)).concat(
      asStringArray((nested as NormalizableInput).tags).filter((t) => t.includes(".")),
    ),
    dependencies: parseDependencies(pick(input.dependencies, nested.dependencies)),
    secretRequirements: asStringArray(pick(input.secretRequirements, input.secrets)),
    network: parseNetwork(pick(input.network, nested.network)),
    instructions,
    files: parseFiles(input.files),
    runtime: asString(input.runtime),
  };
  return SkillManifestSchema.parse(candidate);
}

/** Build the controlled on-disk layout for a skill (no secrets inside). */
export function skillInstallPath(sourceType: string, skillKey: string): string {
  if (skillKey.includes("..") || skillKey.includes("/") || skillKey.includes("\\")) {
    throw new Error("Skill key must not contain path traversal");
  }
  const safeSource = sourceType.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  const safeKey = skillKey.toLowerCase().replace(/[^a-z0-9-_]+/g, "-");
  if (safeKey === "" || safeKey.replace(/-+/g, "") === "") throw new Error("Invalid skill key for path");
  if (safeSource === "") throw new Error("Invalid source for path");
  return `skills/external/${safeSource}/${safeKey}`;
}
