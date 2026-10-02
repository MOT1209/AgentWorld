/**
 * Skill sources.
 *
 * A source identifies WHERE a skill came from, never WHAT it may do.
 * Trust is evaluated separately in trust.ts; a source alone grants nothing.
 */
import { z } from "zod";

export const SKILL_SOURCE_TYPES = [
  "SYSTEM",
  "AGENTWORLD",
  "SKILLS_SH",
  "GITHUB",
  "USER",
  "COMMUNITY",
  "ORGANIZATION",
  "LOCAL",
] as const;

export const SkillSourceTypeSchema = z.enum(SKILL_SOURCE_TYPES);
export type SkillSourceType = z.infer<typeof SkillSourceTypeSchema>;

export const SkillSourceSchema = z.object({
  type: SkillSourceTypeSchema,
  /** Opaque identifier within the source (e.g. skills.sh slug, repo path). */
  identifier: z.string().min(1).max(500),
  url: z.string().max(2000).optional(),
  version: z.string().max(120).optional(),
  /** Pinned revision (commit/tag) when the source supports it. HEAD is unpinned. */
  revision: z.string().max(120).optional(),
});

export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** Source precedence when two records claim the same skill key. Lower wins. */
const SOURCE_PRIORITY: Record<SkillSourceType, number> = {
  SYSTEM: 0,
  AGENTWORLD: 1,
  ORGANIZATION: 2,
  SKILLS_SH: 3,
  GITHUB: 4,
  COMMUNITY: 5,
  USER: 6,
  LOCAL: 7,
};

export function sourcePriority(type: SkillSourceType): number {
  return SOURCE_PRIORITY[type] ?? 50;
}

export function isPinnedSource(source: SkillSource): boolean {
  if (source.type !== "GITHUB") return source.revision !== undefined;
  const rev = (source.revision ?? "").trim();
  return rev !== "" && rev.toUpperCase() !== "HEAD" && rev.toLowerCase() !== "latest";
}

export function parseSkillSource(raw: unknown): SkillSource {
  return SkillSourceSchema.parse(raw);
}
