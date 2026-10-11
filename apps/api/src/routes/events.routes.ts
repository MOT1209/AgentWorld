/**
 * Server-Sent Events stream.
 *
 * The dashboard needs a live view of the simulation (agent state changes,
 * activity starts/completions, goal updates, world status). SSE is the
 * lightest real-time transport that works through plain HTTP and needs no new
 * dependency.
 *
 * EventSource cannot set an Authorization header, so besides the standard
 * bearer header this endpoint accepts a `ticket` query parameter: a 60-second,
 * stream-only token from `POST /events/ticket`. The long-lived access token
 * never goes in a URL. The caller must hold `event.read`.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { buildPrincipal } from "../../../../packages/security/src/rbac.js";
import {
  extractBearerToken,
  signStreamTicket,
  STREAM_TICKET_TTL_SECONDS,
  verifyAccessToken,
  verifyStreamTicket,
} from "../../../../packages/security/src/tokens.js";
import { authenticate, getPrincipal } from "../middleware/authenticate.js";
import { requirePermission } from "../middleware/require-permission.js";
import { PERMISSIONS } from "../../../../packages/security/src/permissions.js";
import { eventBus, type PersistedEvent } from "../../../../packages/events/src/index.js";
import { unauthenticated, forbidden } from "../../../../packages/shared/src/index.js";
import { getCorrelationId } from "../middleware/correlation.js";
import { scopedLogs } from "../middleware/company-scope.js";
import { companyScope, type CompanyScope } from "../../../../packages/security/src/company-access.js";

export const eventsRouter: Router = Router();

const HEARTBEAT_MS = 15_000;

/** User id from the bearer header (access token) or the `ticket` query (stream ticket). */
function resolveStreamUser(req: Request): string {
  const headerToken = extractBearerToken(req.headers.authorization);
  if (headerToken !== null) return verifyAccessToken(headerToken).sub;
  const ticket = req.query.ticket;
  if (typeof ticket === "string" && ticket.length > 0) return verifyStreamTicket(ticket);
  throw unauthenticated("Missing access token or stream ticket for event stream");
}

eventsRouter.post(
  "/ticket",
  authenticate,
  requirePermission(PERMISSIONS.EVENT_READ),
  (req: Request, res: Response): void => {
    res.json({
      data: { ticket: signStreamTicket(getPrincipal(req).userId), expiresInSeconds: STREAM_TICKET_TTL_SECONDS },
      correlationId: getCorrelationId(req),
    });
  },
);

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
    let scope: CompanyScope;
    try {
      const userId = resolveStreamUser(req);
      const user = await prisma.user.findUnique({ where: { id: userId } });
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
      // Resolved once per connection: a grant change applies on reconnect.
      scope = await companyScope(prisma, principal);
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

    let closed = false;
    // Scope checks are async; chaining keeps events in their published order.
    let queue: Promise<void> = Promise.resolve();
    const unsubscribe = eventBus.subscribe("*", (event) => {
      if (!matches(event, filters)) return;
      const send = (): void => {
        if (!closed) write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      if (scope.all) {
        send();
        return;
      }
      queue = queue
        .then(async () => {
          if ((await scopedLogs(scope, [event])).length > 0) send();
        })
        .catch(() => undefined);
    });

    const heartbeat = setInterval(() => {
      write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const cleanup = (): void => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  },
);
