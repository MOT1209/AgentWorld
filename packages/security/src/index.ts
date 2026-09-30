export {
  PERMISSIONS,
  ALL_PERMISSIONS,
  HUMAN_ONLY_PERMISSIONS,
  isPermission,
  isDeclarableToolPermission,
  assertNoHumanOnlyPermissions,
  type Permission,
} from "./permissions.js";

export {
  permissionsForRole,
  roleHasPermission,
  buildPrincipal,
  principalCan,
  principalToActor,
  type Principal,
} from "./rbac.js";

export { hashPassword, verifyPassword, assertPasswordShape } from "./password.js";
export {
  signAccessToken,
  verifyAccessToken,
  extractBearerToken,
  type AccessTokenClaims,
} from "./tokens.js";

export {
  createRateLimiter,
  enforceRateLimit,
  DEFAULT_POLICY,
  LOGIN_POLICY,
  AGENT_RUN_POLICY,
  type RateLimiter,
  type RateLimitPolicy,
  type RateLimitResult,
} from "./rate-limit.js";

export {
  sanitiseText,
  sanitiseMultiline,
  sanitiseIdentifier,
  escapeHtml,
  containsRoleImpersonation,
  type SanitiseOptions,
} from "./sanitize.js";
