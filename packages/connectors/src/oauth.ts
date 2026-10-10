/**
 * OAuth infrastructure -- reusable authorization-code flow for connectors.
 *
 * Legitimate integration only: the flow stores tokens it is *given* by the
 * provider's token endpoint, sealed in the vault. It never scrapes browser
 * sessions, cookies, or subscription walls, and it never exposes tokens to
 * agents -- `revealCredential` is reachable only from server-side call paths.
 *
 * State parameter is a signed, single-use, short-TTL token so callbacks cannot
 * be forged or replayed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbClient } from "../../database/src/index.js";
import { createCredential } from "../../vault/src/index.js";
import { eventBus, EVENT_TYPES } from "../../events/src/index.js";
import { conflict, getConfig, newCorrelationId, validationError, SYSTEM_ACTOR, type ActorRef } from "../../shared/src/index.js";

export interface OAuthProviderConfig {
  /** Connector slug this provider config belongs to. */
  connectorSlug: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Env/config-resolved client id; the secret stays server-side forever. */
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/** Registered OAuth providers. Empty by default: enabling one is deliberate. */
export const OAUTH_PROVIDERS = new Map<string, OAuthProviderConfig>();

const STATE_TTL_MS = 10 * 60_000;
const stateSecret = (): Buffer =>
  createHmac("sha256", getConfig().vault.masterKey !== "" ? getConfig().vault.masterKey : "dev-oauth-state")
    .update("oauth-state-v1")
    .digest();

export interface PendingState {
  connectorSlug: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingState>();

/**
 * Constant-time comparison of the state signature. A `!==` compare leaks how
 * many leading bytes of a forged signature were correct, which is exactly what
 * an attacker needs to reconstruct a valid one byte by byte.
 */
function signaturesMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function beginAuthorization(
  connectorSlug: string,
  ctx: { actor: ActorRef; db: DbClient; correlationId?: string },
): { authorizationUrl: string; state: string } {
  const provider = OAUTH_PROVIDERS.get(connectorSlug);
  if (provider === undefined) {
    throw validationError(`No OAuth provider configured for connector '${connectorSlug}'`);
  }
  const state = randomBytes(24).toString("base64url");
  const signature = createHmac("sha256", stateSecret()).update(state).digest("base64url");
  const signed = `${state}.${signature}`;
  pendingStates.set(state, { connectorSlug, expiresAt: Date.now() + STATE_TTL_MS });

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", `${getConfig().corsOrigins[0] ?? ""}/api/v1/integrations/oauth/callback`);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", signed);

  void eventBus
    .publishAndDispatch(ctx.db, {
      type: EVENT_TYPES.OAUTH_STARTED,
      actor: ctx.actor,
      correlationId: ctx.correlationId ?? newCorrelationId(),
      payload: { credentialId: null, connectorId: connectorSlug, state: signed.slice(0, 12) },
    })
    .catch(() => undefined);

  return { authorizationUrl: url.toString(), state: signed };
}

export interface CallbackResult {
  credentialId: string;
  connectorSlug: string;
}

/**
 * Exchanges the authorization code for tokens and seals them as a credential.
 * The access/refresh tokens never appear in any response.
 */
export async function completeAuthorization(
  input: {
    code: string;
    state: string;
  },
  ctx: { actor: ActorRef; db: DbClient; correlationId?: string; fetchImpl?: typeof fetch },
): Promise<CallbackResult> {
  const [rawState, signature] = input.state.split(".");
  if (rawState === undefined || signature === undefined) throw validationError("Malformed OAuth state");
  const expected = createHmac("sha256", stateSecret()).update(rawState).digest("base64url");
  if (!signaturesMatch(signature, expected)) throw validationError("OAuth state signature mismatch");
  const pending = pendingStates.get(rawState);
  pendingStates.delete(rawState);
  if (pending === undefined || pending.expiresAt < Date.now()) {
    // A signature that verifies but has no pending entry means the state was
    // already used, expired, or was issued by another API instance (the
    // pending map is process-local, so a multi-instance deployment needs the
    // shared store this message points at).
    throw conflict("OAuth state is expired, already used, or was issued by another instance");
  }

  const provider = OAUTH_PROVIDERS.get(pending.connectorSlug);
  if (provider === undefined) throw conflict("OAuth provider was unregistered mid-flow");

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const response = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
    }),
  });
  if (!response.ok) {
    await eventBus
      .publishAndDispatch(ctx.db, {
        type: EVENT_TYPES.OAUTH_FAILED,
        actor: ctx.actor,
        correlationId: ctx.correlationId ?? newCorrelationId(),
        payload: { credentialId: null, connectorId: pending.connectorSlug, reason: `token endpoint HTTP ${response.status}` },
      })
      .catch(() => undefined);
    throw conflict(`Token exchange failed (HTTP ${response.status})`);
  }
  const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (typeof tokens.access_token !== "string" || tokens.access_token === "") {
    throw conflict("Token endpoint did not return an access token");
  }

  const credential = await createCredential(
    ctx.db,
    {
      name: `${pending.connectorSlug}-oauth-${Date.now().toString(36)}`,
      kind: "OAUTH",
      scope: "CONNECTOR",
      refId: pending.connectorSlug,
      secret: tokens.access_token,
      metadata: {
        hasRefreshToken: typeof tokens.refresh_token === "string",
        scopes: tokens.scope ?? provider.scopes.join(" "),
      },
    },
    { actor: ctx.actor, correlationId: ctx.correlationId },
  );
  // Refresh tokens get their own sealed row so rotation can refresh without
  // re-authorizing.
  if (typeof tokens.refresh_token === "string" && tokens.refresh_token !== "") {
    await createCredential(
      ctx.db,
      {
        name: `${credential.name}-refresh`,
        kind: "OAUTH",
        scope: "CONNECTOR",
        refId: pending.connectorSlug,
        secret: tokens.refresh_token,
        metadata: { refreshFor: credential.id },
      },
      { actor: ctx.actor, correlationId: ctx.correlationId },
    );
  }

  await eventBus
    .publishAndDispatch(ctx.db, {
      type: EVENT_TYPES.OAUTH_COMPLETED,
      actor: ctx.actor,
      correlationId: ctx.correlationId ?? newCorrelationId(),
      payload: { credentialId: credential.id, connectorId: pending.connectorSlug },
    })
    .catch(() => undefined);

  return { credentialId: credential.id, connectorSlug: pending.connectorSlug };
}

/** Test hook: clears pending states between tests. */
export function resetOAuthStates(): void {
  pendingStates.clear();
}

export { SYSTEM_ACTOR };
