import type { NextFunction, Request, Response } from "express";
import {
  AGENT_RUN_POLICY,
  DEFAULT_POLICY,
  LOGIN_POLICY,
  createRateLimiter,
  enforceRateLimit,
  type RateLimitPolicy,
} from "../../../../packages/security/src/rate-limit.js";

const limiter = createRateLimiter();

export function rateLimit(policy: RateLimitPolicy = DEFAULT_POLICY, keyPrefix = "global") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ip = (req.ip ?? req.socket.remoteAddress ?? "unknown").toString();
      enforceRateLimit(limiter, `${keyPrefix}:${ip}`, policy);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const loginRateLimit = (): ((req: Request, res: Response, next: NextFunction) => void) =>
  rateLimit(LOGIN_POLICY, "login");

export const agentRunRateLimit = (): ((req: Request, res: Response, next: NextFunction) => void) =>
  rateLimit(AGENT_RUN_POLICY, "agent-run");

export const defaultRateLimit = (): ((req: Request, res: Response, next: NextFunction) => void) =>
  rateLimit(DEFAULT_POLICY, "api");
