import type { NextFunction, Request, Response } from "express";
import { principalCan } from "../../../../packages/security/src/rbac.js";
import type { Permission } from "../../../../packages/security/src/permissions.js";
import { forbidden } from "../../../../packages/shared/src/index.js";
import { getPrincipal } from "./authenticate.js";

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const principal = getPrincipal(req);
      if (!principalCan(principal, permission)) {
        throw forbidden(`Requires permission '${permission}'`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
