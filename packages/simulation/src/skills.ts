/**
 * Skills with levels and experience.
 *
 * Stored in the existing `Agent.skills` JSON column. The column used to hold a
 * plain string[]; `parseSkills` still accepts that legacy shape and upgrades it
 * on read, so no data migration is required.
 *
 * The curve is deliberately simple and deterministic:
 *   experienceToNextLevel(level) = 100 + (level - 1) * 50
 */
import { z } from "zod";
import type { ActivityType } from "../../shared/src/index.js";

export const MAX_SKILL_LEVEL = 100;

export const SkillSchema = z.object({
  name: z.string().min(1).max(80),
  level: z.number().int().min(1).max(MAX_SKILL_LEVEL),
  experience: z.number().int().min(0),
  experienceToNextLevel: z.number().int().min(1),
});

export type Skill = z.infer<typeof SkillSchema>;

export function experienceToNextLevel(level: number): number {
  const safeLevel = Math.max(1, Math.floor(level));
  return 100 + (safeLevel - 1) * 50;
}

export function makeSkill(name: string, level = 1, experience = 0): Skill {
  const safeLevel = Math.min(MAX_SKILL_LEVEL, Math.max(1, Math.floor(level)));
  return {
    name,
    level: safeLevel,
    experience: Math.max(0, Math.floor(experience)),
    experienceToNextLevel: experienceToNextLevel(safeLevel),
  };
}

/** Accepts `["planning"]`, `[{name, level, ...}]`, or empty/garbage. */
export function parseSkills(raw: string | null | undefined): Skill[] {
  if (raw === null || raw === undefined || raw.trim() === "" || raw.trim() === "[]") return [];
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(candidate)) return [];

  const skills: Skill[] = [];
  for (const entry of candidate) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      skills.push(makeSkill(entry.trim().slice(0, 80)));
      continue;
    }
    const parsed = SkillSchema.safeParse(entry);
    if (parsed.success) skills.push(parsed.data);
  }
  return skills;
}

export function serializeSkills(skills: Skill[]): string {
  return JSON.stringify(skills);
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const target = name.trim().toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === target);
}

/**
 * Awards XP and rolls over as many levels as the experience covers.
 * Returns new objects; never mutates the input.
 */
export function grantSkillExperience(
  skills: Skill[],
  name: string,
  xp: number,
): { skills: Skill[]; leveledUp: boolean; skill: Skill } {
  const awarded = Math.max(0, Math.floor(xp));
  const existing = findSkill(skills, name);
  const base = existing ?? makeSkill(name);
  let level = base.level;
  let experience = base.experience + awarded;

  while (level < MAX_SKILL_LEVEL && experience >= experienceToNextLevel(level)) {
    experience -= experienceToNextLevel(level);
    level += 1;
  }
  if (level >= MAX_SKILL_LEVEL) experience = 0;

  const updated = makeSkill(base.name, level, experience);
  const next = existing === undefined ? [...skills, updated] : skills.map((s) => (s === existing ? updated : s));
  return { skills: next, leveledUp: level > base.level, skill: updated };
}

/** XP for completing an activity: short activities still teach something. */
export function xpForActivity(durationSimMinutes: number): number {
  const minutes = Math.max(0, durationSimMinutes);
  return Math.min(60, Math.max(5, Math.round(minutes / 6)));
}

/**
 * Which skill an activity trains. WORK trains the agent's own first skill (its
 * declared specialty); THINK trains planning; SOCIALIZE trains communication.
 * Physical/restful activities train nothing.
 */
export function skillForActivity(activity: ActivityType, skills: Skill[]): string | null {
  switch (activity) {
    case "WORK":
      return skills[0]?.name ?? "Execution";
    case "THINK":
      return findSkill(skills, "Planning")?.name ?? "Planning";
    case "SOCIALIZE":
      return findSkill(skills, "Communication")?.name ?? "Communication";
    default:
      return null;
  }
}
