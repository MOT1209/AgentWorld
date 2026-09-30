/**
 * Transaction helpers.
 *
 * SQLite serialises writers, so a busy-wait retry loop is the honest way to
 * handle SQLITE_BUSY rather than pretending a longer timeout solves it. The
 * ledger relies on this: two concurrent transfers from the same wallet must
 * serialise, and the retry makes the second one see the first one's committed
 * balance instead of failing opaquely.
 */
import { Prisma, PrismaClient } from "@prisma/client";

export type DbClient = PrismaClient | Prisma.TransactionClient;

export const PRISMA_TX_OPTS = {
  maxWait: 10_000,
  timeout: 20_000,
} as const;

const BUSY_PATTERN =
  /SQLITE_BUSY|database is locked|write conflict|deadlock|concurrent modification/i;
const MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  attempts?: number;
  /** Injectable for tests. */
  delay?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Retries only transient contention errors. Anything else propagates. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const delay = options.delay ?? sleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
      if (!BUSY_PATTERN.test(message) || attempt === attempts) throw error;
      options.onRetry?.(attempt, error);
      await delay(25 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/**
 * Runs `fn` inside a database transaction, retrying the whole transaction on
 * transient contention. Safe because `fn` must be free of external side
 * effects -- see LedgerService, which writes nothing outside the transaction.
 */
export async function withTransaction<T>(
  client: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  return withRetry(
    () => client.$transaction(fn, PRISMA_TX_OPTS),
    options,
  );
}

export { Prisma };
