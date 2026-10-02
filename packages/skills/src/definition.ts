/**
 * The runtime Skill definition.
 *
 * A Skill is a versioned capability package that teaches an Agent HOW to
 * perform a class of work. It is deliberately NOT a prompt and NOT a tool:
 *
 *   Skill = HOW    (procedure, judgement, ordering)
 *   Tool  = WHAT   (a single system operation)
 *
 * This file holds ONE definition type on purpose. Built-in skills and
 * externally installed bundles both normalize into `SkillDefinition`, so the
 * registry, resolver, and execution pipeline never need to know which
 * originated where. `fromManifest` is the seam: it lowers the existing
 * external `SkillManifest` (see types.ts) into this shape rather than
 * introducing a parallel manifest concept.
 *
 * Security invariants enforced here and relied upon downstream:
 *
 *  1. A Skill DECLARES requirements. It never confers them. `requiredPermissions`
 *     and `allowedTools` are *requests* the resolver checks against the
 *     agent's real grants; a skill cannot grant itself authority.
 *  2. `allowedTools` is a NARROWING constraint. The tools an execution may
 *     actually use are the intersection of the agent's permission-filtered
 *     tool list and this list. A skill can remove access, never add it.
 *  3. A skill's declared risk is bounded by its trust level, checked in
 *     `assertTrustConsistency`. An EXPERIMENTAL bundle cannot declare
 *     CRITICAL risk and inherit the looser expectations that come with it.
 */
import { z } from "zod";
import {
  SKILL_TRUST_RISK_CEILING,
  type RiskLevel,
  type SkillCategory,
  type SkillStatus,
  type SkillTrustLevel,
} from "../../shared/src/index.js";
import { isPermission, type Permission } from "../../security/src/permissions.js";
import type { JsonSchema } from "../../ai/src/json-schema.js";
import type { SkillManifest } from "./types.js";

export const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSkillKey(value: string): boolean {
  return value.length > 0 && value.length <= 120 && SKILL_KEY_PATTERN.test(value);
}

export function isSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function skillKeyWithVersion(key: string, version: string): string {
  return `${key}@${version}`;
}

/** A declared dependency on another skill, optionally version-constrained. */
export const SkillDependencyRefSchema = z.object({
  key: z.string().min(1).max(120),
  /** Caret/tilde/exact range; "*" and absent both mean any. */
  versionRange: z.string().max(120).optional(),
});
export type SkillDependencyRef = z.infer<typeof SkillDependencyRefSchema>;

/**
 * Context handed to a skill body. Assembled by the execution pipeline
 * (see execution.ts) and deliberately narrow: a skill is told what it needs,
 * not handed the database.
 */
export interface SkillExecutionContext {
  skillKey: string;
  skillVersion: string;
  agentId: string;
  taskId?: string;
  sessionId?: string;
  workspaceId?: string;
  companyId?: string;
  worldId?: string;
  locationId?: string;
  /** Simulation clock reading, when the execution is simulation-driven. */
  simulatedNow?: string;
  correlationId: string;
  input: Record<string, unknown>;
}

/** What a skill body returns. Validated against outputSchema when declared. */
export interface SkillOutcome<TOutput = unknown> {
  output: TOutput;
  /** One line for the timeline and audit trail. */
  summary?: string;
  /** Artifacts produced (file paths, task ids, message ids). */
  artifacts?: Array<{ type: string; ref: string }>;
}

/**
 * The body of a skill.
 *
 * Pure by contract: it receives only its context and must reach the world only
 * through the injected invoker. A skill body never receives a database handle,
 * which is what makes "skills cannot bypass authorization" checkable instead
 * of aspirational -- there is no back door to bypass it with.
 */
export interface SkillHandler<TOutput = unknown> {
  execute(
    context: SkillExecutionContext,
    tools: SkillToolInvoker,
  ): Promise<SkillOutcome<TOutput>> | SkillOutcome<TOutput>;
}

/**
 * The only capability a skill body has. Deliberately narrower than
 * ToolExecutor: it enforces the skill's own `allowedTools` narrowing and the
 * agent's effective permissions on every call, so a skill cannot reach a tool
 * the agent could not use, nor a tool outside its own declaration.
 */
export interface SkillToolInvoker {
  invoke(toolName: string, args: unknown): Promise<unknown>;
}

export interface SkillDefinition<TOutput = unknown> {
  key: string;
  name: string;
  version: string;
  description: string;
  category: SkillCategory;
  status: SkillStatus;
  /** How much this skill may be trusted; bounds its declared risk. */
  trustLevel: SkillTrustLevel;
  riskLevel: RiskLevel;
  /** Ordered guidance. Layered into the prompt, never concatenated blindly. */
  instructions: readonly string[];
  /**
   * Capabilities the agent must declare to use this skill. These are the
   * existing Agent.capabilities ids (packages/agents/capabilities.ts), NOT a
   * new namespace: a skill does not introduce a second capability system.
   */
  requiredCapabilities: readonly string[];
  /** Permissions the agent must hold. Requests only -- grants nothing. */
  requiredPermissions: readonly Permission[];
  /** Tools this skill may use. Narrows the agent's effective tool list. */
  allowedTools: readonly string[];
  dependencies: readonly SkillDependencyRef[];
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** System-owned skills ship with AgentWorld and cannot be replaced. */
  systemOwned: boolean;
  handler?: SkillHandler<TOutput>;
  examples?: readonly string[];
}

export function skillDefinition<TOutput>(
  input: Omit<SkillDefinition<TOutput>, "status" | "trustLevel" | "systemOwned"> & {
    status?: SkillStatus;
    trustLevel?: SkillTrustLevel;
    systemOwned?: boolean;
  },
): SkillDefinition<TOutput> {
  return {
    ...input,
    status: input.status ?? "ACTIVE",
    trustLevel: input.trustLevel ?? "SYSTEM",
    systemOwned: input.systemOwned ?? true,
  };
}

/** Stable, order-independent fingerprint used for conflict detection (§43). */
export function definitionFingerprint(definition: SkillDefinition): string {
  return JSON.stringify({
    key: definition.key,
    version: definition.version,
    category: definition.category,
    risk: definition.riskLevel,
    instructions: [...definition.instructions].sort(),
    permissions: [...definition.requiredPermissions].sort(),
    tools: [...definition.allowedTools].sort(),
    capabilities: [...definition.requiredCapabilities].sort(),
  });
}

export class SkillDefinitionError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "SkillDefinitionError";
    this.issues = issues;
  }
}

/**
 * Structural validation of a definition. This is the gate every skill passes
 * before it can enter the registry: unknown permissions, malformed keys,
 * out-of-order risk vs trust, and handlers missing from executable skills all
 * fail here rather than mid-execution.
 */
export function assertValidSkillDefinition(definition: SkillDefinition): SkillDefinition {
  const issues: string[] = [];

  if (!isValidSkillKey(definition.key)) {
    issues.push(`key '${definition.key}' must be lowercase [a-z0-9._-] and start alphanumeric`);
  }
  if (!isSemver(definition.version)) {
    issues.push(`skill '${definition.key}' has non-semver version '${definition.version}'`);
  }
  if (definition.name.trim().length === 0) {
    issues.push(`skill '${definition.key}' needs a name`);
  }
  if (definition.description.trim().length === 0) {
    issues.push(`skill '${definition.key}' needs a description`);
  }

  const unknownPermissions = definition.requiredPermissions.filter((p) => !isPermission(p));
  if (unknownPermissions.length > 0) {
    issues.push(`skill '${definition.key}' requires unknown permissions: ${unknownPermissions.join(", ")}`);
  }

  const ceiling = SKILL_TRUST_RISK_CEILING[definition.trustLevel];
  if (riskRank(definition.riskLevel) > riskRank(ceiling)) {
    issues.push(
      `skill '${definition.key}' declares ${definition.riskLevel} risk but ${definition.trustLevel} trust allows at most ${ceiling}`,
    );
  }

  if (definition.status === "ACTIVE" && definition.handler === undefined) {
    issues.push(
      `skill '${definition.key}' is ACTIVE but has no handler; a skill with no body cannot execute`,
    );
  }

  const selfDependency = definition.dependencies.find((d) => d.key === definition.key);
  if (selfDependency !== undefined) {
    issues.push(`skill '${definition.key}' depends on itself`);
  }

  const seen = new Set<string>();
  for (const dep of definition.dependencies) {
    if (seen.has(dep.key)) issues.push(`skill '${definition.key}' declares duplicate dependency '${dep.key}'`);
    seen.add(dep.key);
  }

  if (issues.length > 0) {
    throw new SkillDefinitionError(
      `Skill definition '${definition.key}' is invalid: ${issues.join("; ")}`,
      issues,
    );
  }
  return definition;
}

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function riskRank(risk: RiskLevel): number {
  return RISK_RANK[risk];
}

/**
 * Lower an external `SkillManifest` into a runtime `SkillDefinition`.
 *
 * This is the bridge between the supply-chain layer (types.ts, validator.ts,
 * security-analyzer.ts) and the runtime. Trust is derived from the manifest's
 * reviewed trust when present, never from the manifest's own claim, so an
 * untrusted bundle cannot promote itself by declaring `trustLevel: SYSTEM`.
 */
export function fromManifest(
  manifest: SkillManifest,
  options: {
    /** Trust already established by the supply-chain review, not by the file. */
    reviewedTrust: SkillTrustLevel;
    category?: SkillCategory;
    status?: SkillStatus;
    handler?: SkillHandler;
  },
): SkillDefinition {
  const permissions = manifest.permissions.filter((p): p is Permission => isPermission(p));
  const droppedPermissions = manifest.permissions.filter((p) => !isPermission(p));

  const definition: SkillDefinition = {
    key: manifest.key,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    category: options.category ?? "CORE_INTELLIGENCE",
    status: options.status ?? "ACTIVE",
    trustLevel: options.reviewedTrust,
    riskLevel: "LOW",
    instructions: manifest.instructions.trim() === "" ? [] : [manifest.instructions],
    requiredCapabilities: manifest.capabilities,
    requiredPermissions: permissions,
    allowedTools: manifest.tools,
    dependencies: manifest.dependencies.map((d) => ({ key: d.key, versionRange: d.versionRange })),
    systemOwned: false,
  };

  if (droppedPermissions.length > 0) {
    // Permissions that do not exist cannot be requested, and cannot be
    // silently mapped onto something an agent does hold.
    throw new SkillDefinitionError(
      `Skill '${manifest.key}' requests permissions that are not in the catalogue: ${droppedPermissions.join(", ")}`,
      droppedPermissions,
    );
  }
  if (manifest.key.startsWith("agent:")) {
    throw new SkillDefinitionError(`Skill key '${manifest.key}' may not impersonate a built-in namespace`);
  }
  return assertValidSkillDefinition(definition);
}

/** Human-facing summary for API and dashboard listings. */
export interface SkillSummary {
  key: string;
  name: string;
  version: string;
  description: string;
  category: SkillCategory;
  status: SkillStatus;
  trustLevel: SkillTrustLevel;
  riskLevel: RiskLevel;
  requiredCapabilities: readonly string[];
  requiredPermissions: readonly Permission[];
  allowedTools: readonly string[];
  dependencies: readonly SkillDependencyRef[];
  systemOwned: boolean;
}

export function summarize(definition: SkillDefinition): SkillSummary {
  return {
    key: definition.key,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    category: definition.category,
    status: definition.status,
    trustLevel: definition.trustLevel,
    riskLevel: definition.riskLevel,
    requiredCapabilities: definition.requiredCapabilities,
    requiredPermissions: definition.requiredPermissions,
    allowedTools: definition.allowedTools,
    dependencies: definition.dependencies,
    systemOwned: definition.systemOwned,
  };
}

// NOTE: lifecycle status/trust/category/tier schemas are NOT re-exported here.
// They live in @kingworld/shared, which is the single source of truth. This
// package already exports a *different* `SkillStatus` from types.ts describing
// an external bundle's catalog listing state (DISCOVERED | INSTALLED | ...),
// so re-exporting the lifecycle names would make `SkillStatus` ambiguous at
// the package boundary. Consumers get lifecycle types from @kingworld/shared.