/**
 * External skills ecosystem.
 *
 * Entry point. Every export is a pure domain module: providers discover
 * and fetch, the normalizer converts, the validator and security analyzer
 * judge, trust records review, and the installer orchestrates the gated
 * flow. Nothing here touches the network, the database, or the filesystem
 * except through injected adapters, so tests stay hermetic.
 */
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
