import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";
import { validationError } from "../../../../packages/shared/src/index.js";

type Location = "body" | "query" | "params";

export function validate(location: Location, schema: ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const source = location === "body" ? req.body : location === "query" ? req.query : req.params;
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      next(validationError(`Invalid ${location}`, details));
      return;
    }
    if (location === "body") req.body = parsed.data;
    else if (location === "query") req.query = parsed.data as never;
    else req.params = parsed.data as never;
    next();
  };
}
