/**
 * MCP endpoint (/api/v1/mcp).
 *
 * Accepts JSON-RPC frames from external AI agents authenticated with an API
 * key (`Authorization: Bearer aw_...`). Transport is plain HTTPS POST; the
 * same handler also backs a future stdio transport.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../../../../packages/database/src/index.js";
import { parseApiKey } from "../../../../packages/security/src/api-keys.js";
import { handleMcpRequest, MCP_TOOLS, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../../../../packages/mcp/src/index.js";
import { rateLimited } from "../../../../packages/shared/src/index.js";

export const mcpRouter: Router = Router();

/**
 * Fixed one-minute window per client IP. Keyed by IP, not by the presented
 * key: an unauthenticated caller could otherwise rotate made-up `aw_` prefixes
 * and get a fresh bucket on every request.
 */
const buckets = new Map<string, { minute: number; count: number }>();
const GC_THRESHOLD = 1_000;

export function rateLimitClient(clientKey: string, limit = 120, nowMs = Date.now()): void {
  const minute = Math.floor(nowMs / 60_000);
  const bucket = buckets.get(clientKey);
  if (bucket === undefined || bucket.minute !== minute) {
    if (buckets.size >= GC_THRESHOLD) {
      for (const [key, value] of buckets) if (value.minute !== minute) buckets.delete(key);
    }
    buckets.set(clientKey, { minute, count: 1 });
    return;
  }
  if (bucket.count >= limit) throw rateLimited("MCP rate limit exceeded, retry in a minute");
  bucket.count += 1;
}

mcpRouter.get("/", (_req: Request, res: Response): void => {
  res.json({
    data: {
      server: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: MCP_TOOLS.map((tool) => tool.name),
      auth: "Authorization: Bearer aw_<api-key>",
    },
  });
});

mcpRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      rateLimitClient(req.ip ?? "unknown");
      const apiKey = parseApiKey(req.headers.authorization);
      const response = await handleMcpRequest(
        { db: prisma, apiKey, clientName: req.headers["user-agent"] ?? null },
        req.body,
      );
      res.json(response);
    } catch (error) {
      next(error);
    }
  },
);
