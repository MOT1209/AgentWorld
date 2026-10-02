/**
 * Installation flow orchestrator.
 *
 * DISCOVER -> SELECT -> FETCH METADATA -> FETCH CONTENT -> VALIDATE MANIFEST
 * -> VALIDATE VERSION -> VALIDATE DEPENDENCIES -> SECURITY ANALYSIS
 * -> CAPABILITY ANALYSIS -> PERMISSION ANALYSIS -> TRUST EVALUATION
 * -> USER REVIEW -> APPROVAL WHEN REQUIRED -> INSTALL -> REGISTER -> ENABLE.
 *
 * Validation is never skipped. Installing makes a skill AVAILABLE; execution
 * still passes through capability -> permission -> policy -> tool ->
 * approval -> execution, enforced elsewhere.
 */
import { normalizeExternalSkill } from "./normalizer.js";
import { validateManifest, validateVersionCompatibility, compareVersions } from "./validator.js";
import { analyzeExternalSkill, requiresHumanReview, blocksInstallation } from "./security-analyzer.js";
import { evaluateTrust } from "./trust.js";
import { classifyCompatibility } from "./compatibility.js";
import { resolveDependencies } from "./dependencies.js";
import { diffVersions } from "./versions.js";
import { skillIntegrityHash } from "./integrity.js";
import { reviewPermissions, assertDownScope } from "./permissions-review.js";
import { detectSkillInjection } from "./prompt-injection.js";
import { blankRecord, type SkillCatalog } from "./catalog.js";
import type { SecurityReport, SkillCatalogRecord, SkillManifest, TrustLevel } from "./types.js";
import type { SkillSource } from "./sources.js";

export type InstallStep =
  | "FETCH"
  | "VALIDATE_MANIFEST"
  | "VALIDATE_VERSION"
  | "VALIDATE_DEPENDENCIES"
  | "SECURITY_ANALYSIS"
  | "TRUST_EVALUATION"
  | "PERMISSION_REVIEW"
  | "APPROVAL"
  | "INSTALL"
  | "REGISTER"
  | "ENABLE";

export interface InstallPlan {
  manifest: SkillManifest;
  securityReport: SecurityReport;
  trust: TrustLevel;
  compatibility: SkillCatalogRecord["compatibility"];
  compatibilityReason: string;
  integrityHash: string;
  permissionReview: { requested: string[]; allowed: string[]; denied: string[] };
  approvalRequired: boolean;
  approvalReason: string | null;
  dependencyOrder: string[];
  injectionBlocked: boolean;
}

export interface InstallOptions {
  source: SkillSource;
  externalId: string;
  rawManifest: unknown;
  files?: Record<string, string>;
  hostVersion?: string;
  availableManifests?: Map<string, SkillManifest>;
  explicitlyVerified?: boolean;
  explicitlyBlocked?: boolean;
  allowedPermissions?: string[] | null;
  autoEnable?: boolean;
}

export function planInstallation(options: InstallOptions): InstallPlan {
  // FETCH + NORMALIZE (raw external content is never executed directly).
  const manifest = normalizeExternalSkill(options.rawManifest, {
    externalId: options.externalId,
    source: options.source,
  });

  // VALIDATE MANIFEST (never skipped).
  const validation = validateManifest(manifest);
  if (!validation.valid || validation.manifest === null) {
    throw new Error(`Skill manifest invalid: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }

  // VALIDATE VERSION.
  if (options.hostVersion !== undefined) {
    const versionIssues = validateVersionCompatibility(manifest, options.hostVersion);
    if (versionIssues.length > 0) {
      throw new Error(`Skill version incompatible: ${versionIssues.map((i) => i.message).join("; ")}`);
    }
  }

  // VALIDATE DEPENDENCIES (missing/circular/incompatible/dangerous/untrusted).
  const available = options.availableManifests ?? new Map<string, SkillManifest>();
  const withSelf = new Map(available);
  withSelf.set(manifest.key, manifest);
  const resolution = resolveDependencies(manifest, withSelf);
  const blockingDep = resolution.issues.find(
    (i) => i.kind === "MISSING" || i.kind === "CIRCULAR" || i.kind === "DANGEROUS",
  );
  if (blockingDep !== undefined) {
    throw new Error(`Skill dependencies unresolved: ${blockingDep.message}`);
  }

  // SECURITY ANALYSIS.
  const files = options.files ?? {};
  const securityReport = analyzeExternalSkill(manifest, files);
  if (blocksInstallation(securityReport)) {
    throw new Error(
      `Skill '${manifest.key}' blocked by security analysis (${securityReport.riskLevel}): ` +
        securityReport.findings.map((f) => f.message).slice(0, 3).join("; "),
    );
  }

  // PROMPT-INJECTION gate: hard block, even when the analyzer only warns.
  const injection = detectSkillInjection(manifest, files);
  if (injection.injected) {
    throw new Error(`Skill '${manifest.key}' blocked: prompt-injection pattern detected (${injection.matches[0] ?? "override"}).`);
  }

  // TRUST EVALUATION.
  const trust = evaluateTrust({
    sourceType: options.source.type,
    explicitlyVerified: options.explicitlyVerified ?? false,
    explicitlyBlocked: options.explicitlyBlocked ?? false,
    report: securityReport,
  });
  if (trust === "BLOCKED") throw new Error(`Skill '${manifest.key}' is BLOCKED by trust evaluation.`);

  // COMPATIBILITY.
  const compatibility = classifyCompatibility(manifest, securityReport);
  if (compatibility.compatibility === "BLOCKED" || compatibility.compatibility === "UNSUPPORTED") {
    throw new Error(`Skill '${manifest.key}' cannot be installed: ${compatibility.reason}`);
  }

  // PERMISSION ANALYSIS + DOWN-SCOPING.
  const review = reviewPermissions(manifest.permissions, options.allowedPermissions ?? null);
  assertDownScope(review);

  const approvalRequired =
    requiresHumanReview(securityReport) ||
    review.requiresExplicitApproval.length > 0 ||
    trust === "SUSPICIOUS" ||
    compatibility.compatibility === "REQUIRES_RUNTIME";
  const approvalReason = approvalRequired
    ? [
        review.requiresExplicitApproval.length > 0
          ? `dangerous permissions: ${review.requiresExplicitApproval.join(", ")}`
          : null,
        securityReport.riskLevel !== "LOW" ? `risk ${securityReport.riskLevel}` : null,
        trust === "SUSPICIOUS" ? "trust SUSPICIOUS" : null,
        compatibility.compatibility === "REQUIRES_RUNTIME" ? "requires isolated runtime" : null,
      ]
        .filter((s): s is string => s !== null)
        .join("; ") || "human review required"
    : null;

  return {
    manifest,
    securityReport,
    trust,
    compatibility: compatibility.compatibility,
    compatibilityReason: compatibility.reason,
    integrityHash: skillIntegrityHash(manifest, files),
    permissionReview: { requested: review.requested, allowed: review.allowed, denied: review.denied },
    approvalRequired,
    approvalReason,
    dependencyOrder: resolution.order,
    injectionBlocked: false,
  };
}

/** Commit a planned install into the catalog (caller enforces approval first). */
export function commitInstallation(catalog: SkillCatalog, source: SkillSource, externalId: string, plan: InstallPlan, opts: { enable?: boolean; now?: string } = {}): SkillCatalogRecord {
  const now = opts.now ?? new Date().toISOString();
  const existing = catalog.get(plan.manifest.key);
  const base =
    existing ??
    blankRecord({
      key: plan.manifest.key,
      name: plan.manifest.name,
      description: plan.manifest.description,
      source,
      externalId,
      availableVersion: plan.manifest.version,
      ...(plan.manifest.author !== undefined ? { author: plan.manifest.author } : {}),
      ...(plan.manifest.repository !== undefined ? { repository: plan.manifest.repository } : {}),
      ...(plan.manifest.category !== undefined ? { category: plan.manifest.category } : {}),
    });
  const historyEntry = {
    version: plan.manifest.version,
    integrityHash: plan.integrityHash,
    installedAt: now,
  };
  const record: SkillCatalogRecord = {
    ...base,
    name: plan.manifest.name,
    description: plan.manifest.description,
    source,
    externalId,
    installedVersion: plan.manifest.version,
    availableVersion: plan.manifest.version,
    author: plan.manifest.author ?? base.author,
    repository: plan.manifest.repository ?? base.repository,
    category: plan.manifest.category ?? base.category,
    trust: plan.trust,
    risk: plan.securityReport.riskLevel,
    status: opts.enable === true ? "ENABLED" : "INSTALLED",
    compatibility: plan.compatibility,
    compatibilityReason: plan.compatibilityReason,
    installed: true,
    enabled: opts.enable === true,
    manifest: plan.manifest,
    securityReport: plan.securityReport,
    integrityHash: plan.integrityHash,
    grantedPermissions: plan.permissionReview.allowed,
    deniedPermissions: plan.permissionReview.denied,
    versionHistory: [...base.versionHistory.filter((h) => h.version !== plan.manifest.version), historyEntry].slice(-5),
    lastChecked: now,
    lastUpdated: now,
  };
  return catalog.upsert(record);
}

/** Plan an update OLD -> NEW with diff + approval gating on widened authority. */
export function planUpdate(oldManifest: SkillManifest, newRaw: unknown, source: SkillSource, externalId: string, files: Record<string, string> = {}): InstallPlan & { diff: ReturnType<typeof diffVersions> } {
  const plan = planInstallation({ source, externalId, rawManifest: newRaw, files });
  if (compareVersions(plan.manifest.version, oldManifest.version) <= 0) {
    throw new Error(`Update must be newer than installed ${oldManifest.version} (got ${plan.manifest.version}).`);
  }
  if (plan.manifest.key !== oldManifest.key) {
    throw new Error("Update must keep the same skill key.");
  }
  const diff = diffVersions(oldManifest, plan.manifest);
  const widened = diff.widensAuthority;
  return {
    ...plan,
    approvalRequired: plan.approvalRequired || widened,
    approvalReason: widened ? `update widens authority (+${diff.addedPermissions.join(",") || "capabilities/tools"})` : plan.approvalReason,
    diff,
  };
}
