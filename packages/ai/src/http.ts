/**
 * HTTP helper for provider adapters.
 *
 * Every outbound provider call goes through here so that timeout handling,
 * error classification and secret redaction are implemented exactly once.
 * Credentials live in closure-scoped headers and are never echoed into an
 * error message or a log record.
 */
import { aiProviderError, logger } from "../../shared/src/index.js";

const log = logger.child({ component: "ai.http" });

export interface HttpResult<T> {
  data: T;
  status: number;
  latencyMs: number;
}

export interface HttpOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  providerId: string;
  correlationId?: string;
}

export async function postJson<T>(options: HttpOptions): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(options.url, {
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      // Provider error bodies can echo the request, which may contain the
      // API key. Truncate and strip before it reaches a log or a client.
      throw aiProviderError(
        `Provider '${options.providerId}' returned HTTP ${response.status}`,
        sanitiseProviderError(text, response.status),
      );
    }

    try {
      return { data: JSON.parse(text) as T, status: response.status, latencyMs };
    } catch {
      throw aiProviderError(
        `Provider '${options.providerId}' returned a non-JSON response`,
        text.slice(0, 500),
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw aiProviderError(
        `Provider '${options.providerId}' timed out after ${options.timeoutMs}ms`,
      );
    }
    log.warn("Provider request failed", {
      action: "ai.http_failed",
      result: "ERROR",
      providerId: options.providerId,
      correlationId: options.correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps only the informative part of a provider error body. */
function sanitiseProviderError(body: string, status: number): string {
  let message = body.slice(0, 500);
  // Remove anything that looks like a bearer token or api key.
  message = message
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED_KEY]")
    .replace(/("(?:api[_-]?key|authorization)"\s*:\s*")[^"]+/gi, "$1[REDACTED]");
  return `HTTP ${status}: ${message}`;
}
