/**
 * Password hashing.
 *
 * bcrypt with a configurable cost. Two hardening choices worth stating:
 *
 *  - The cost factor is clamped to >= 10. A misconfigured `BCRYPT_ROUNDS=4`
 *    would otherwise silently produce hashes that are trivial to crack, and a
 *    downgrade should be impossible to express.
 *  - Verification is constant-time by construction of bcrypt, and a failed
 *    verify against a non-bcrypt string is rejected immediately so a malformed
 *    row cannot be distinguished from a wrong password by timing.
 */
import bcrypt from "bcryptjs";
import { getConfig } from "../../shared/src/index.js";

const MIN_ROUNDS = 10;
const MAX_ROUNDS = 15;
const BCRYPT_PREFIX = "$2";

export function hashPassword(plain: string, rounds?: number): string {
  assertPasswordShape(plain);
  const configured = rounds ?? getConfig().bcryptRounds;
  const cost = Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, configured));
  return bcrypt.hashSync(plain, cost);
}

export function verifyPassword(plain: string, hash: string): boolean {
  if (!looksLikeBcrypt(hash)) return false;
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

function looksLikeBcrypt(hash: string): boolean {
  return typeof hash === "string" && hash.startsWith(BCRYPT_PREFIX) && hash.length >= 59;
}

/**
 * Enforced at the credential boundary (registration, seed, password change).
 * bcrypt silently truncates beyond 72 *bytes*, so a longer input must be
 * refused rather than quietly weakened.
 */
export function assertPasswordShape(plain: string): void {
  if (typeof plain !== "string" || plain.length < 10) {
    throw new Error("Password must be at least 10 characters");
  }
  if (Buffer.byteLength(plain, "utf8") > 72) {
    throw new Error("Password must not exceed 72 bytes");
  }
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    throw new Error("Password must contain both letters and digits");
  }
}
