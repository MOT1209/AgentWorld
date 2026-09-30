/**
 * Input hardening.
 *
 * Three distinct concerns, one file:
 *
 *  1. Log/audit injection - control characters and CR/LF are stripped so a
 *     crafted agent name cannot forge extra lines in the activity timeline.
 *  2. Length bounds - every free-text field that reaches the database or an
 *     LLM prompt is bounded, so a single message cannot blow up the context
 *     window or the audit table.
 *  3. HTML escaping - used at any point user text is rendered unescaped.
 *
 * The control-character patterns are built with the RegExp constructor rather
 * than regex literals so no raw control byte ever appears in this file.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
const LINE_BREAKS = new RegExp("[\\r\\n]+", "g");
const ROLE_MARKER = new RegExp("(^|\\n)\\s*(system|assistant|developer)\\s*:", "i");

export interface SanitiseOptions {
  maxLength?: number;
  /** Replace line breaks with a single space. Default true. */
  collapseNewlines?: boolean;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function sanitiseText(input: unknown, options: SanitiseOptions = {}): string {
  const { maxLength = 10_000, collapseNewlines = true } = options;
  if (input === null || input === undefined) return "";
  let text = String(input);
  text = text.replace(CONTROL_CHARS, "");
  if (collapseNewlines) text = text.replace(LINE_BREAKS, " ");
  return truncate(text.trim(), maxLength);
}

/** Preserves newlines (for message bodies) but still removes control chars. */
export function sanitiseMultiline(input: unknown, maxLength = 20_000): string {
  if (input === null || input === undefined) return "";
  return truncate(String(input).replace(CONTROL_CHARS, ""), maxLength);
}

export function sanitiseIdentifier(input: unknown, maxLength = 128): string {
  return truncate(sanitiseText(input, { maxLength, collapseNewlines: true }), maxLength)
    .replace(/[^A-Za-z0-9._:-]/g, "");
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Rejects text that tries to impersonate a system directive.
 *
 * Agents read human text verbatim, so an untrusted message beginning with role
 * markers is an injection vector. This is a cheap, honest mitigation. It does
 * NOT make prompt injection impossible, and nothing here should be mistaken
 * for a guarantee. The actual boundary is structural: an agent can only ever
 * cause effects through tools, and every tool is permission- and
 * approval-gated.
 */
export function containsRoleImpersonation(input: string): boolean {
  return ROLE_MARKER.test(input);
}
