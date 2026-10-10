/**
 * Deterministic character appearance derived from the stable agent id.
 *
 * The same agent id always yields the same visual identity across refreshes
 * and restarts. Appearance is derived ONLY from the id — never from the
 * agent's name, role, or any personal characteristic — so nothing about
 * gender, age, or looks is inferred or invented.
 */

export interface CharacterAppearance {
  /** Skin-tone material color (hex). */
  skin: number;
  /** Torso / clothing material color (hex). */
  clothing: number;
  /** Legs / trousers material color (hex). */
  pants: number;
  /** Hair material color (hex). */
  hair: number;
  /** Hairstyle variant index (0..HAIRSTYLE_COUNT-1). */
  hairStyle: number;
  /** Build variant index (0 slim, 1 regular, 2 broad). */
  build: number;
  /** Idle-animation phase offset in radians (0..2π). */
  phase: number;
}

export const SKIN_TONES: readonly number[] = [
  0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac,
];

export const CLOTHING_COLORS: readonly number[] = [
  0x0ea5e9, 0x22c55e, 0xf59e0b, 0xef4444, 0x8b5cf6, 0xec4899, 0x14b8a6, 0x64748b,
];

export const PANTS_COLORS: readonly number[] = [
  0x1f2937, 0x334155, 0x57534e, 0x1e3a8a, 0x3f3f46, 0x44403c,
];

export const HAIR_COLORS: readonly number[] = [
  0x1c1917, 0x44403c, 0x78350f, 0xb45309, 0x6b7280,
];

export const HAIRSTYLE_COUNT = 4;
export const BUILD_COUNT = 3;

/** Agent-state badge colors. Kept in sync with the legacy STATE_COLORS. */
const STATE_COLORS: Readonly<Record<string, number>> = {
  IDLE: 0x94a3b8,
  ONLINE: 0x14b8a6,
  WORKING: 0x22c55e,
  THINKING: 0x3b82f6,
  WAITING: 0xeab308,
  SLEEPING: 0x6366f1,
  TRAVELING: 0xf59e0b,
  RESTING: 0xa78bfa,
  SOCIALIZING: 0xec4899,
  OFFLINE: 0x475569,
  PAUSED: 0x64748b,
  ERROR: 0xef4444,
};

export const FALLBACK_STATE_COLOR = 0x94a3b8;

/** FNV-1a 32-bit hash. Stable across sessions and platforms. */
export function hashStringToUint32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick<T>(palette: readonly T[], slot: number): T {
  const item = palette[slot % palette.length];
  // `slot % length` is always in range; the guard is for `noUncheckedIndexedAccess`.
  if (item === undefined) throw new Error("Empty appearance palette");
  return item;
}

/**
 * Derives a stable appearance for an agent id. Pure and side-effect free:
 * the same id always returns an equal object.
 */
export function appearanceForAgentId(agentId: string): CharacterAppearance {
  const h = hashStringToUint32(agentId);
  return {
    skin: pick(SKIN_TONES, h),
    clothing: pick(CLOTHING_COLORS, h >>> 3),
    pants: pick(PANTS_COLORS, h >>> 5),
    hair: pick(HAIR_COLORS, h >>> 7),
    hairStyle: (h >>> 9) % HAIRSTYLE_COUNT,
    build: (h >>> 11) % BUILD_COUNT,
    phase: ((h % 1000) / 1000) * Math.PI * 2,
  };
}

/** Badge color for an agent state; unknown states fall back to neutral. */
export function stateColorHex(state: string): number {
  return STATE_COLORS[state] ?? FALLBACK_STATE_COLOR;
}
