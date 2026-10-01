import type { NextFunction, Request, Response } from "express";
import { isAppError, logger, toAppError } from "../../../../packages/shared/src/index.js";
import { getCorrelationId } from "./correlation.js";

const log = logger.child({ component: "api.error-handler" });

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = isAppError(error) ? error : toAppError(error);
  const correlationId = getCorrelationId(req);

  if (appError.httpStatus >= 500) {
    log.error(appError.message, {
      action: "api.error",
      result: "ERROR",
      correlationId,
      error: appError,
      path: req.path,
      method: req.method,
    });
  } else {
    log.warn(appError.message, {
      action: "api.client_error",
      result: "ERROR",
      correlationId,
      path: req.path,
      method: req.method,
      code: appError.code,
    });
  }

  const body = appError.toJSON() as { error: Record<string, unknown> };
  res.status(appError.httpStatus).json({ ...body.error, correlationId });
}

export function notFoundHandler(req: Request, res: Response): void {
  const correlationId = getCorrelationId(req);
  res.status(404).json({
    code: "NOT_FOUND",
    message: `Route ${req.method} ${req.path} not found`,
    correlationId,
  });
}
