/**
 * External skills ecosystem.
 *
 * Entry point. Every export is a pure domain module: providers discover
 * and fetch, the normalizer converts, the validator and security analyzer
 * judge, trust records review, and the installer orchestrates the gated
 * flow. Nothing here touches the network, the database, or the filesystem
 * except through injected adapters, so tests stay hermetic.
 */
/**
 * Runtime skill definition.
 *
 * Re-exported by explicit name, not `export *`: this package also exports a
 * catalog-listing `SkillStatus` from ./types.js, so a wildcard would make
 * `SkillStatus` ambiguous here. Lifecycle types come from @kingworld/shared.
 */
export {
  SKILL_KEY_PATTERN,
  SEMVER_PATTERN,
  isValidSkillKey,
  isSemver,
  skillKeyWithVersion,
  SkillDependencyRefSchema,
  skillDefinition,
  definitionFingerprint,
  SkillDefinitionError,
  assertValidSkillDefinition,
  riskRank,
  fromManifest,
  summarize,
} from "./definition.js";
export type {
  SkillDefinition,
  SkillDependencyRef,
  SkillExecutionContext,
  SkillHandler,
  SkillOutcome,
  SkillSummary,
  SkillToolInvoker,
} from "./definition.js";

export * from "./sources.js";
export * from "./types.js";
export * from "./normalizer.js";
export * from "./providers.js";
export * from "./validator.js";
export * from "./security-analyzer.js";
export * from "./trust.js";
export * from "./compatibility.js";
export * from "./dependencies.js";
export * from "./versions.js";
export * from "./integrity.js";
export * from "./lockfile.js";
export * from "./catalog.js";
export * from "./installer.js";
export * from "./permissions-review.js";
export * from "./prompt-injection.js";
export * from "./resolver.js";
export * from "./analytics.js";
