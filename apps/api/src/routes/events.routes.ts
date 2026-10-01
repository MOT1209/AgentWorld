/**
 * Server-Sent Events stream.
 *
 * The dashboard needs a live view of the simulation (agent state changes,
 * activity starts/completions, goal updates, world status). SSE is the
 * lightest real-time transport that works through plain HTTP and needs no new
 * dependency.
 *
 * EventSource cannot set an Authorization header, so this endpoint accepts the
 * access token via the `token` query parameter as well as the standard bearer
 * header. The token is verified and the caller must hold `event.read`.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { buildPrincipal } from "../../../../packages/security/src/rbac.js";
import { extractBearerToken, verifyAccessToken } from "../../../../packages/security/src/tokens.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { eventBus, type PersistedEvent } from "../../../../packages/events/src/index.js";
import { unauthenticated, forbidden } from "../../../../packages/shared/src/index.js";
import { getCorrelationId } from "../middleware/correlation.js";

export const eventsRouter: Router = Router();

const HEARTBEAT_MS = 15_000;

function resolveToken(req: Request): string {
  const headerToken = extractBearerToken(req.headers.authorization);
  if (headerToken !== null) return headerToken;
  const queryToken = req.query.token;
  if (typeof queryToken === "string" && queryToken.length > 0) return queryToken;
  throw unauthenticated("Missing access token for event stream");
}

function matches(event: PersistedEvent, filters: Map<string, string>): boolean {
  for (const [key, value] of filters) {
    if (key === "worldId" && event.worldId !== value) return false;
    if (key === "companyId" && event.companyId !== value) return false;
    if (key === "type" && event.type !== value) return false;
  }
  return true;
}

eventsRouter.get(
  "/stream",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let principal;
    try {
      const claims = verifyAccessToken(resolveToken(req));
      const user = await prisma.user.findUnique({ where: { id: claims.sub } });
      if (user === null || user.isActive !== true) throw unauthenticated("Account is inactive or missing");
      principal = buildPrincipal({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      });
      if (!principal.permissions.has(PERMISSIONS.EVENT_READ)) {
        throw forbidden("Event stream requires 'event.read'");
      }
    } catch (error) {
      next(error);
      return;
    }

    const filters = new Map<string, string>();
    for (const key of ["worldId", "companyId", "type"] as const) {
      const value = req.query[key];
      if (typeof value === "string" && value.length > 0) filters.set(key, value);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const correlationId = getCorrelationId(req);
    const write = (chunks: string): void => {
      res.write(chunks);
    };
    write(`event: connected\ndata: ${JSON.stringify({ correlationId })}\n\n`);

    const unsubscribe = eventBus.subscribe("*", (event) => {
      if (!matches(event, filters)) return;
      write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  },
);
