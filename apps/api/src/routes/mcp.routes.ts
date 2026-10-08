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

const seenPerMinute = new Map<string, number>();

function rateLimitClient(clientKey: string, limit = 120): void {
  const now = Math.floor(Date.now() / 60_000);
  const bucket = seenPerMinute.get(`${clientKey}:${now}`) ?? 0;
  if (bucket === 0) {
    // opportunistic GC of old buckets
    for (const key of seenPerMinute.keys()) {
      const minute = Number(key.split(":")[1] ?? 0);
      if (Number.isFinite(minute) && now - minute > 2) seenPerMinute.delete(key);
    }
  }
  if (bucket >= limit) throw rateLimited("MCP rate limit exceeded, retry in a minute");
  seenPerMinute.set(`${clientKey}:${now}`, bucket + 1);
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
      const apiKey = parseApiKey(req.headers.authorization);
      const clientKey = apiKey?.slice(0, 8) ?? "anonymous";
      rateLimitClient(clientKey);
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
