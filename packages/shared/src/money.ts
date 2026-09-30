/**
 * Money -- integer-only value object.
 *
 * Design constraints and why they exist:
 *
 *  1. Amounts are stored and computed as MINOR UNITS (integers). A float
 *     `0.1 + 0.2 !== 0.3`, and an economy that cannot add 0.1 to 0.2 correctly
 *     is not an economy, it is a random number generator.
 *  2. Currency is part of the value. `Money.add` across two currencies throws
 *     instead of silently producing nonsense.
 *  3. `MAX_MINOR` is enforced on every operation. Amounts live in an
 *     `Int` column (SQLite has no unsigned 64-bit mapped to Prisma Int), so
 *     overflow is possible in principle. Making it impossible in the value
 *     object turns a silent corruption into a loud, located error.
 *
 * Phase 2 upgrade path: switch the column to `BigInt` / Postgres
 * `numeric(19,4)` and raise this ceiling. Nothing else changes, because all
 * arithmetic is already routed through this module.
 */
import { DEFAULT_CURRENCY } from "./enums.js";

/** 2_147_483_647 minor units == 21,474,836.47 KW. */
export const MAX_MINOR = 2_147_483_647;
export const MIN_MINOR = -2_147_483_647;

const CURRENCY_PATTERN = /^[A-Z]{2,5}$/;

function assertCurrency(currency: string): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new RangeError(`Invalid currency code: ${JSON.stringify(currency)}`);
  }
  return currency;
}

function assertMinor(value: number): number {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Money amount must be an integer of minor units, received ${value}`);
  }
  if (value > MAX_MINOR || value < MIN_MINOR) {
    throw new RangeError(`Money amount ${value} exceeds the supported range`);
  }
  return value;
}

export class Money {
  readonly minor: number;
  readonly currency: string;

  private constructor(minor: number, currency: string) {
    this.minor = assertMinor(minor);
    this.currency = assertCurrency(currency);
    Object.freeze(this);
  }

  static zero(currency: string = DEFAULT_CURRENCY): Money {
    return new Money(0, currency);
  }

  static fromMinor(minor: number, currency: string = DEFAULT_CURRENCY): Money {
    return new Money(minor, currency);
  }

  /**
   * Converts a human-entered major-unit amount (e.g. 12.34) to minor units
   * using decimal-string arithmetic, so 0.1 + 0.2 is not involved anywhere.
   */
  static fromMajor(major: number | string, currency: string = DEFAULT_CURRENCY): Money {
    const normalised = typeof major === "number" ? major.toString() : major.trim();
    const match = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(normalised);
    if (!match) {
      throw new RangeError(`Invalid amount: ${JSON.stringify(major)}`);
    }
    const [, sign, whole, fracRaw] = match;
    const frac = fracRaw ?? "";
    if (frac.length > 2) {
      throw new RangeError(
        `Amount ${normalised} has more than 2 decimal places; this currency uses minor units`,
      );
    }
    const padded = frac.padEnd(2, "0");
    const minor = Number(whole) * 100 + Number(padded || "0");
    return new Money(sign === "-" ? -minor : minor, currency);
  }

  /** Lenient parser used by the HTTP boundary and the LLM tool-call bridge. */
  static parse(input: number | string, currency: string = DEFAULT_CURRENCY): Money {
    if (typeof input === "number") return Money.fromMajor(input, currency);
    return Money.fromMajor(input, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new RangeError(
        `Currency mismatch: cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  /** Absolute-value arithmetic for magnitudes (fees, risk limits, limits). */
  addMagnitude(minor: number): Money {
    return new Money(this.minor + Math.abs(minor), this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return new Money(Math.abs(this.minor), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor === other.minor) return 0;
    return this.minor < other.minor ? -1 : 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  get isZero(): boolean {
    return this.minor === 0;
  }

  get isPositive(): boolean {
    return this.minor > 0;
  }

  get isNegative(): boolean {
    return this.minor < 0;
  }

  /**
   * Major units as a float, for display and for LLM consumption only.
   * Never use the result of this for arithmetic.
   */
  toMajor(): number {
    return this.minor / 100;
  }

  /** Canonical fixed-point string, e.g. "-12.30". Safe for the ledger. */
  toString(): string {
    const sign = this.minor < 0 ? "-" : "";
    const abs = Math.abs(this.minor);
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, "0");
    return `${sign}${whole}.${frac}`;
  }

  toJSON(): { minor: number; major: number; currency: string; formatted: string } {
    return {
      minor: this.minor,
      major: this.toMajor(),
      currency: this.currency,
      formatted: `${this.toString()} ${this.currency}`,
    };
  }
}

export function money(minor: number, currency: string = DEFAULT_CURRENCY): Money {
  return Money.fromMinor(minor, currency);
}

export function sumMoney(values: Iterable<Money>, currency = DEFAULT_CURRENCY): Money {
  let total = Money.zero(currency);
  for (const value of values) total = total.add(value);
  return total;
}
