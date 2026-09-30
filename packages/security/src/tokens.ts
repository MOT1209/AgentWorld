/**
 * API access tokens.
 *
 * - HS256 with an explicit algorithm allow-list. `jsonwebtoken` will happily
 *   accept `alg: none` and other algorithm-confusion payloads unless the
 *   algorithm is pinned, so the verify options below are load-bearing.
 * - `issuer` + `audience` are verified, so a token minted for another service
 *   sharing the secret is rejected.
 * - The payload carries only identifiers and the role. No secrets, no email
 *   addresses beyond what the owner already knows, and nothing an operator
 *   would not want visible in a decoded token.
 */
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import { getConfig, unauthenticated, UserRole, type UserRole as UserRoleType } from "../../shared/src/index.js";

const ISSUER = "kingworld-api";
const AUDIENCE = "kingworld-dashboard";
const ALLOWED_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

export interface AccessTokenClaims extends JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRoleType;
}

export function signAccessToken(input: {
  userId: string;
  email: string;
  displayName: string;
  role: UserRoleType;
  expiresIn?: string;
}): string {
  const config = getConfig();
  const options: SignOptions = {
    algorithm: "HS256",
    expiresIn: (input.expiresIn ?? config.jwt.expiresIn) as SignOptions["expiresIn"],
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: input.userId,
    jwtid: `${input.userId}-${Date.now().toString(36)}`,
  };
  return jwt.sign(
    { email: input.email, name: input.displayName, role: input.role },
    config.jwt.secret,
    options,
  );
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, getConfig().jwt.secret, {
      algorithms: ALLOWED_ALGORITHMS,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof decoded === "string" || decoded.sub === undefined) {
      throw unauthenticated("Malformed access token");
    }
    const role = decoded.role;
    if (typeof role !== "string" || !Object.values(UserRole).includes(role as UserRoleType)) {
      throw unauthenticated("Access token carries an unknown role");
    }
    return decoded as AccessTokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthenticated("Access token expired");
    }
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.NotBeforeError) {
      throw unauthenticated("Invalid access token");
    }
    throw error;
  }
}

/** Extracts a bearer token without validating it. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}
