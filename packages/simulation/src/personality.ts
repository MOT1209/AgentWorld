/**
 * Structured personality.
 *
 * Persisted in the existing `Agent.personality` JSON column (no new table), so
 * the Phase 1 upgrade is data-only. Values are normalised 0..1.
 *
 * This is SIMULATION DATA, not a psychological claim. The five broad
 * dimensions are borrowed as a convenient, well-known parameterisation; the
 * extra attributes are the ones the decision engine actually reads. Nothing in
 * the system may present these numbers as measuring a real person.
 */
import { z } from "zod";
import { fromJson } from "../../shared/src/index.js";

const unit = z.number().min(0).max(1);

export const WORK_PREFERENCES = ["FOCUSED", "BALANCED", "COLLABORATIVE", "FLEXIBLE"] as const;
export const COMMUNICATION_STYLES = ["DIRECT", "DIPLOMATIC", "DETAILED", "CONCISE"] as const;

export const PersonalitySchema = z.object({
  openness: unit,
  conscientiousness: unit,
  extraversion: unit,
  agreeableness: unit,
  emotionalStability: unit,
  ambition: unit,
  curiosity: unit,
  patience: unit,
  riskTolerance: unit,
  sociability: unit,
  workPreference: z.enum(WORK_PREFERENCES),
  communicationStyle: z.enum(COMMUNICATION_STYLES),
});

export type Personality = z.infer<typeof PersonalitySchema>;

export const DEFAULT_PERSONALITY: Personality = {
  openness: 0.5,
  conscientiousness: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  emotionalStability: 0.5,
  ambition: 0.5,
  curiosity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
  sociability: 0.5,
  workPreference: "BALANCED",
  communicationStyle: "DIRECT",
};

/**
 * Role-biased defaults. The bias is DATA, not a branch on a name: any agent
 * given the PLANNER role starts from the same profile.
 */
const ROLE_BIAS: Record<string, Partial<Personality>> = {
  PLANNER: {
    openness: 0.8,
    conscientiousness: 0.85,
    curiosity: 0.8,
    ambition: 0.7,
    patience: 0.7,
    workPreference: "FOCUSED",
    communicationStyle: "DETAILED",
  },
  EXECUTOR: {
    conscientiousness: 0.9,
    extraversion: 0.65,
    ambition: 0.75,
    riskTolerance: 0.45,
    workPreference: "COLLABORATIVE",
    communicationStyle: "CONCISE",
  },
  REVIEWER: {
    conscientiousness: 0.9,
    agreeableness: 0.6,
    patience: 0.8,
    riskTolerance: 0.3,
    communicationStyle: "DETAILED",
  },
  ANALYST: {
    openness: 0.85,
    curiosity: 0.9,
    conscientiousness: 0.75,
    patience: 0.75,
    communicationStyle: "DETAILED",
  },
};

export function defaultPersonalityForRole(roleKey: string): Personality {
  const bias = ROLE_BIAS[roleKey.toUpperCase()];
  return bias === undefined ? { ...DEFAULT_PERSONALITY } : { ...DEFAULT_PERSONALITY, ...bias };
}

/**
 * Reads the column defensively: an empty object or any legacy shape yields the
 * role default rather than throwing, because a personality is configuration and
 * must never block the simulation from starting.
 */
export function parsePersonality(
  raw: string | null | undefined,
  roleKey = "EXECUTOR",
): Personality {
  if (raw === null || raw === undefined || raw.trim() === "" || raw.trim() === "{}") {
    return defaultPersonalityForRole(roleKey);
  }
  const candidate = fromJson<unknown>(raw, null);
  if (candidate === null || typeof candidate !== "object") {
    return defaultPersonalityForRole(roleKey);
  }
  const parsed = PersonalitySchema.safeParse({ ...defaultPersonalityForRole(roleKey), ...(candidate as object) });
  return parsed.success ? parsed.data : defaultPersonalityForRole(roleKey);
}
