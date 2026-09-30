/**
 * Structured application errors.
 *
 * Every error carries a stable machine-readable `code` plus an HTTP status.
 * The API layer maps errors through `toErrorResponse` and nothing else needs to
 * know about HTTP. Internal failures are reported as a generic 500 with no
 * leaked detail; the full detail goes to the structured log instead.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "APPROVAL_REQUIRED"
  | "INSUFFICIENT_FUNDS"
  | "INVALID_STATE_TRANSITION"
  | "TOOL_PERMISSION_DENIED"
  | "AI_PROVIDER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  // 409 rather than 202: the caller's intent could not be fulfilled now and
  // retrying it unchanged will fail identically until a human decides.
  APPROVAL_REQUIRED: 409,
  INSUFFICIENT_FUNDS: 409,
  INVALID_STATE_TRANSITION: 409,
  TOOL_PERMISSION_DENIED: 403,
  AI_PROVIDER_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
  /** Set false for expected, non-actionable conditions (e.g. 404 on lookup). */
  operational?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly operational: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = options.details;
    this.operational = options.operational ?? true;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const validationError = (message: string, details?: unknown) =>
  new AppError("VALIDATION_ERROR", message, { details });

export const unauthenticated = (message = "Authentication required") =>
  new AppError("UNAUTHENTICATED", message);

export const forbidden = (message = "Insufficient permissions", details?: unknown) =>
  new AppError("FORBIDDEN", message, { details });

export const notFound = (resource: string, id?: string) =>
  new AppError("NOT_FOUND", id ? `${resource} '${id}' not found` : `${resource} not found`, {
    operational: true,
  });

export const conflict = (message: string, details?: unknown) =>
  new AppError("CONFLICT", message, { details });

export const rateLimited = (message: string, retryAfterSeconds?: number) =>
  new AppError("RATE_LIMITED", message, {
    details: retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
  });

export const approvalRequired = (message: string, details?: unknown) =>
  new AppError("APPROVAL_REQUIRED", message, { details });

export const insufficientFunds = (message: string, details?: unknown) =>
  new AppError("INSUFFICIENT_FUNDS", message, { details });

export const invalidStateTransition = (from: string, to: string, entity: string) =>
  new AppError(
    "INVALID_STATE_TRANSITION",
    `${entity} cannot move from ${from} to ${to}`,
    { details: { from, to, entity } },
  );

export const toolPermissionDenied = (tool: string, permission: string) =>
  new AppError("TOOL_PERMISSION_DENIED", `Agent lacks permission '${permission}' for tool '${tool}'`, {
    details: { tool, permission },
  });

export const aiProviderError = (message: string, cause?: unknown) =>
  new AppError("AI_PROVIDER_ERROR", message, { cause });

export const serviceUnavailable = (message: string, details?: unknown) =>
  new AppError("SERVICE_UNAVAILABLE", message, { details });

export const internalError = (message = "Internal server error", cause?: unknown) =>
  new AppError("INTERNAL_ERROR", message, { cause, operational: false });

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalises anything thrown into an AppError. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return internalError(error.message, error);
  }
  return internalError("Unknown error", error);
}
