import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../../../packages/database/src/index.js";
import { verifyPassword } from "../../../../packages/security/src/password.js";
import { signAccessToken } from "../../../../packages/security/src/tokens.js";
import { buildPrincipal, principalToActor } from "../../../../packages/security/src/rbac.js";
import { eventBus } from "../../../../packages/events/src/index.js";
import { recordActivity } from "../../../../packages/events/src/audit.js";
import { EVENT_TYPES } from "../../../../packages/events/src/index.js";
import { newCorrelationId } from "../../../../packages/shared/src/index.js";
import { toSafeUser } from "../dto/index.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { loginRateLimit } from "../middleware/rate-limit.js";

const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

export const authRouter: Router = Router();

authRouter.post(
  "/login",
  loginRateLimit(),
  validate("body", LoginSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const correlationId = getCorrelationId(req);
      const body = req.body as z.infer<typeof LoginSchema>;
      const email = body.email.trim().toLowerCase();

      const user = await prisma.user.findUnique({ where: { email } });
      if (user === null || user.isActive !== true) {
        await eventBus.publishAndDispatch(prisma, {
          type: EVENT_TYPES.LOGIN_FAILED,
          actor: { actorType: "SYSTEM", actorName: "auth" },
          correlationId,
          payload: { email, reason: "unknown_or_inactive" },
        });
        res.status(401).json({ code: "UNAUTHENTICATED", message: "Invalid credentials", correlationId });
        return;
      }

      const ok = verifyPassword(body.password, user.passwordHash);
      if (!ok) {
        await eventBus.publishAndDispatch(prisma, {
          type: EVENT_TYPES.LOGIN_FAILED,
          actor: { actorType: "SYSTEM", actorName: "auth" },
          correlationId,
          payload: { email, reason: "bad_password" },
        });
        res.status(401).json({ code: "UNAUTHENTICATED", message: "Invalid credentials", correlationId });
        return;
      }

      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      const principal = buildPrincipal({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      });
      const token = signAccessToken({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: principal.role,
      });

      await eventBus.publishAndDispatch(prisma, {
        type: EVENT_TYPES.LOGIN_SUCCEEDED,
        actor: principalToActor(principal),
        correlationId,
        payload: { userId: user.id, email: user.email },
      });
      await recordActivity(prisma, {
        actor: principalToActor(principal),
        action: "auth.login",
        targetType: "User",
        targetId: user.id,
        correlationId,
        userId: user.id,
        ip: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });

      res.json({ token, user: toSafeUser(user), correlationId });
    } catch (error) {
      next(error);
    }
  },
);

authRouter.get("/me", authenticate, (req: Request, res: Response, next: NextFunction): void => {
  try {
    const principal = getPrincipal(req);
    const correlationId = req.body as unknown;
    void correlationId;
    res.json({
      userId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      role: principal.role,
      permissions: [...principal.permissions],
      correlationId: (req as Request & { correlationId?: string }).correlationId ?? newCorrelationId(),
    });
  } catch (error) {
    next(error);
  }
});
