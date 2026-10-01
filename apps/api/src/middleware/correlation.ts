import type { NextFunction, Request, Response } from "express";
import { newCorrelationId, normaliseCorrelationId } from "../../../../packages/shared/src/index.js";

export interface CorrelatedRequest extends Request {
  correlationId: string;
}

export function correlationMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const incoming = req.headers["x-correlation-id"];
  const correlationId =
    typeof incoming === "string" && incoming.length > 0
      ? normaliseCorrelationId(incoming)
      : newCorrelationId();
  (req as CorrelatedRequest).correlationId = correlationId;
  next();
}

export function getCorrelationId(req: Request): string {
  const maybe = (req as Partial<CorrelatedRequest>).correlationId;
  if (typeof maybe === "string" && maybe.length > 0) return maybe;
  return newCorrelationId();
}
