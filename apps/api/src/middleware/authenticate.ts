import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { buildPrincipal, type Principal } from "../../../../packages/security/src/rbac.js";
import { extractBearerToken, verifyAccessToken } from "../../../../packages/security/src/tokens.js";
import { unauthenticated } from "../../../../packages/shared/src/index.js";

export interface AuthenticatedRequest extends Request {
  principal: Principal;
  correlationId: string;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    const token = extractBearerToken(header);
    if (token === null) throw unauthenticated("Missing Authorization Bearer token");
    const claims = verifyAccessToken(token);
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (user === null || user.isActive !== true) throw unauthenticated("Account is inactive or missing");
    (req as AuthenticatedRequest).principal = buildPrincipal({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    });
    next();
  } catch (error) {
    next(error);
  }
}

export function getPrincipal(req: Request): Principal {
  const maybe = (req as Partial<AuthenticatedRequest>).principal;
  if (maybe === undefined) throw unauthenticated("Authentication required");
  return maybe;
}
