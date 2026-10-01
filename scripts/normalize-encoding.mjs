/**
 * One-shot repository encoding normaliser (Windows code-page repair).
 *
 * The shell this repo was authored from emits CP1252 bytes for typographic
 * characters and a UTF-8 BOM for files written via PowerShell `Set-Content`.
 * Both are unacceptable in source: the BOM breaks strict JSON parsers and the
 * stray high bytes decode as U+FFFD.
 *
 * This script repairs both, then enforces ASCII-only so the tree is portable
 * across shells and editors. It is idempotent and safe to re-run.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const EXTS = new Set([".ts", ".tsx", ".json", ".js", ".mjs", ".cjs", ".prisma", ".md", ".sql", ".css", ".html", ".yml", ".yaml"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".testsprite"]);

// CP1252 0x80-0x9F -> intended character. Only needed for files that are NOT
// valid UTF-8 (i.e. were written through the ANSI code page).
const CP1252 = {
  0x20ac: "EUR", 0x201a: ",", 0x0192: "f", 0x201e: '"', 0x2026: "...",
  0x2020: "+", 0x2021: "++", 0x02c6: "^", 0x2030: "%", 0x0160: "S",
  0x2039: "<", 0x0152: "OE", 0x017d: "Z", 0x2018: "'", 0x2019: "'",
  0x201c: '"', 0x201d: '"', 0x2022: "-", 0x2013: "-", 0x2014: "--",
  0x02dc: "~", 0x2122: "TM", 0x0161: "s", 0x203a: ">", 0x0153: "oe",
  0x017e: "z", 0x0178: "Y",
};

// Intended Unicode -> ASCII, applied to files that already are valid UTF-8.
const UNICODE = {
  "\u2014": "--", "\u2013": "-", "\u2012": "-", "\u2212": "-",
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->",
  "\u2500": "-", "\u2501": "-", "\u2502": "|", "\u2503": "|",
  "\u251c": "|-", "\u2514": "`-", "\u250c": ".-", "\u2510": "-.",
  "\u2518": ".-", "\u2550": "=", "\u2551": "||",
  "\u2554": "=", "\u2557": "=", "\u255a": "=", "\u255d": "=",
  "\u2566": "=", "\u2569": "=", "\u256c": "=", "\u2570": "=",
  "\u00d7": "x", "\u00b7": "-", "\u2026": "...", "\u2022": "-",
  "\u00a0": " ", "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
  "\u2039": "<", "\u203a": ">", "\u00ab": "<<", "\u00bb": ">>",
  "\u2122": "(TM)", "\u00ae": "(R)", "\u00a9": "(C)",
  "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u00b1": "+/-",
  "\u2588": "#", "\u2591": ".", "\u2592": ":", "\u2593": ":",
  "\u2713": "x", "\u2714": "x", "\u2717": "x", "\u2716": "x",
  "\u26a0": "!", "\u2699": "", "\u2139": "i",
  "\ufeff": "", "\u200b": "", "\u200c": "", "\u200d": "",
};

function toAscii(text) {
  let out = "";
  for (const char of text) {
    const mapped = UNICODE[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0);
    if (code <= 0x7f) {
      out += char;
      continue;
    }
    // Remaining non-ASCII: decompose accents, then drop anything left.
    const folded = char.normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "");
    if (/^[\x20-\x7e]+$/.test(folded)) {
      out += folded;
      continue;
    }
    out += "?";
  }
  return out;
}

function repair(text) {
  const looksLatin1 = text.includes("\uFFFD");
  const source = looksLatin1 ? decodeCp1252(text) : text;
  return toAscii(source);
}

/** Re-reads the buffer as single bytes and expands CP1252 punctuation. */
function decodeCp1252(text) {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const mapped = CP1252[code];
    out += mapped !== undefined ? mapped : char;
  }
  return out;
}

let changed = 0;
let checked = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXTS.has(extname(entry))) continue;
    if (entry === "normalize-encoding.mjs") continue;

    checked += 1;
    const original = readFileSync(full);
    const decoded = original.toString("utf8");
    const strippedBom = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
    const ascii = repair(strippedBom);
    // Normalise line endings to LF: git diffs and typecheck both behave better.
    const finalText = ascii.replace(/\r\n/g, "\n");

    const next = Buffer.from(finalText, "utf8");
    if (!next.equals(original)) {
      writeFileSync(full, next);
      changed += 1;
      console.log("repaired:", full.replace(ROOT + "\\", "").replace(ROOT + "/", ""));
    }
  }
}

walk(ROOT);
console.log(`\nchecked ${checked} file(s), repaired ${changed}.`);
