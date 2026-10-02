/**
 * Shared skill types.
 *
 * The normalized manifest is the ONLY shape the registry, validator,
 * security analyzer, and installer ever see. Every provider normalizes
 * its external format into this shape first; raw content is never executed.
 */
import { z } from "zod";
import { SkillSourceSchema, type SkillSource } from "./sources.js";

export const TRUST_LEVELS = [
  "SYSTEM",
  "VERIFIED",
  "TRUSTED_EXTERNAL",
  "UNVERIFIED",
  "SUSPICIOUS",
  "BLOCKED",
] as const;
export const TrustLevelSchema = z.enum(TRUST_LEVELS);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const SKILL_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const SkillRiskLevelSchema = z.enum(SKILL_RISK_LEVELS);
export type SkillRiskLevel = z.infer<typeof SkillRiskLevelSchema>;

export const SKILL_COMPATIBILITY = [
  "NATIVE_COMPATIBLE",
  "ADAPTABLE",
  "REQUIRES_RUNTIME",
  "UNSUPPORTED",
  "BLOCKED",
] as const;
export const SkillCompatibilitySchema = z.enum(SKILL_COMPATIBILITY);
export type SkillCompatibility = z.infer<typeof SkillCompatibilitySchema>;

export const SKILL_STATUS = [
  "DISCOVERED",
  "INSTALLED",
  "ENABLED",
  "DISABLED",
  "BLOCKED",
  "MODIFIED",
] as const;
export const SkillStatusSchema = z.enum(SKILL_STATUS);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

export const SkillDependencySchema = z.object({
  key: z.string().min(1).max(120),
  versionRange: z.string().max(120).optional(),
});
export type SkillDependency = z.infer<typeof SkillDependencySchema>;

export const SkillNetworkPolicySchema = z.object({
  access: z.boolean().default(false),
  domains: z.array(z.string().min(1).max(253)).max(50).default([]),
});
export type SkillNetworkPolicy = z.infer<typeof SkillNetworkPolicySchema>;

export const SkillFileRefSchema = z.object({
  path: z.string().min(1).max(500),
  hash: z.string().max(128).optional(),
  sizeBytes: z.number().int().min(0).optional(),
});
export type SkillFileRef = z.infer<typeof SkillFileRefSchema>;

export const SkillManifestSchema = z.object({
  key: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-_]*$/, "key must be lowercase alphanumeric with -/_"),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  version: z.string().min(1).max(60),
  author: z.string().max(200).optional(),
  publisher: z.string().max(200).optional(),
  license: z.string().max(120).optional(),
  repository: z.string().max(2000).optional(),
  category: z.string().max(120).optional(),
  capabilities: z.array(z.string().min(1).max(120)).max(100).default([]),
  permissions: z.array(z.string().min(1).max(120)).max(100).default([]),
  tools: z.array(z.string().min(1).max(160)).max(100).default([]),
  dependencies: z.array(SkillDependencySchema).max(50).default([]),
  secretRequirements: z.array(z.string().min(1).max(120)).max(50).default([]),
  network: SkillNetworkPolicySchema.default({ access: false, domains: [] }),
  instructions: z.string().max(100000).default(""),
  files: z.array(SkillFileRefSchema).max(200).default([]),
  runtime: z.string().max(120).optional(),
  minCompatibleVersion: z.string().max(60).optional(),
  maxCompatibleVersion: z.string().max(60).optional(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const ExternalSkillListingSchema = z.object({
  externalId: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  version: z.string().max(60).optional(),
  author: z.string().max(200).optional(),
  repository: z.string().max(2000).optional(),
  category: z.string().max(120).optional(),
  source: SkillSourceSchema,
});
export type ExternalSkillListing = z.infer<typeof ExternalSkillListingSchema>;

export const SkillDiscoveryQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  author: z.string().max(200).optional(),
  repository: z.string().max(2000).optional(),
  keyword: z.string().max(200).optional(),
  compatibility: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type SkillDiscoveryQuery = z.infer<typeof SkillDiscoveryQuerySchema>;

export interface SecurityFinding {
  code: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message: string;
  file?: string;
  evidence?: string;
}

export interface SecurityReport {
  riskLevel: SkillRiskLevel;
  findings: SecurityFinding[];
  requestedCapabilities: string[];
  requestedPermissions: string[];
  requestedTools: string[];
  recommendations: string[];
  scannedAt: string;
}

export interface SkillCatalogRecord {
  key: string;
  name: string;
  description: string;
  source: SkillSource;
  externalId: string;
  installedVersion: string | null;
  availableVersion: string | null;
  author: string | null;
  repository: string | null;
  category: string | null;
  trust: TrustLevel;
  risk: SkillRiskLevel;
  status: SkillStatus;
  compatibility: SkillCompatibility;
  compatibilityReason: string | null;
  installed: boolean;
  enabled: boolean;
  manifest: SkillManifest | null;
  securityReport: SecurityReport | null;
  integrityHash: string | null;
  grantedPermissions: string[];
  deniedPermissions: string[];
  versionHistory: Array<{ version: string; integrityHash: string; installedAt: string }>;
  lastChecked: string | null;
  lastUpdated: string | null;
}
