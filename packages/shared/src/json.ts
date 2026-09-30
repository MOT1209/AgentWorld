/**
 * Safe JSON handling for the SQLite-backed schema.
 *
 * SQLite has no `jsonb`, so structured columns are `String`. Every read and
 * write of such a column goes through these helpers, which means a malformed
 * row degrades to the supplied fallback and logs nothing rather than throwing
 * inside a query result mapper.
 */

export function toJson(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new TypeError("Value is not JSON-serialisable", { cause });
  }
}

export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

export function toJsonArray(raw: string | null | undefined): string[] {
  return fromJson<string[]>(raw, []);
}

export function toJsonObject(raw: string | null | undefined): Record<string, unknown> {
  return fromJson<Record<string, unknown>>(raw, {});
}

/** Removes undefined values so JSON payloads stay small and diff-friendly. */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as Partial<T>;
}
