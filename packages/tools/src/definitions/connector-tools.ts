/**
 * Connector tools.
 *
 * `connector.call` is the single governed path from an agent to an external
 * service. Credentials are resolved server-side via the vault -- the agent
 * sees action results, never tokens. Installation and marketplace browsing are
 * separate tools with different risk profiles.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import type { ToolDefinition } from "../types.js";
import { callConnector, marketplaceCatalog, getDescriptor } from "../../../connectors/src/index.js";
import { validationError } from "../../../shared/src/index.js";

export const connectorListTool: ToolDefinition<Record<string, never>> = {
  name: "connector.list",
  description: "List the connector marketplace: what is available, what each connector can do, and how it authenticates.",
  inputSchema: z.object({}),
  requiredPermission: PERMISSIONS.CONNECTOR_READ,
  risk: "LOW",
  async execute() {
    return {
      data: {
        connectors: marketplaceCatalog().map((descriptor) => ({
          slug: descriptor.slug,
          displayName: descriptor.displayName,
          kind: descriptor.kind,
          auth: descriptor.auth,
          description: descriptor.description,
          actions: descriptor.actions.map((action) => action.name),
          setupNotes: descriptor.setupNotes ?? null,
        })),
      },
      summary: `${marketplaceCatalog().length} connectors in the marketplace`,
    };
  },
};

export const connectorGetTool: ToolDefinition<{ slug: string }> = {
  name: "connector.get",
  description: "Show one connector's full action catalogue and required setup.",
  inputSchema: z.object({ slug: z.string().max(60) }),
  requiredPermission: PERMISSIONS.CONNECTOR_READ,
  risk: "LOW",
  async execute(_context, input) {
    const descriptor = getDescriptor(input.slug);
    return {
      data: {
        slug: descriptor.slug,
        displayName: descriptor.displayName,
        kind: descriptor.kind,
        auth: descriptor.auth,
        description: descriptor.description,
        actions: descriptor.actions,
        setupNotes: descriptor.setupNotes ?? null,
      },
      summary: `${descriptor.actions.length} actions on ${descriptor.displayName}`,
    };
  },
};

export const connectorCallTool: ToolDefinition<{
  slug: string;
  action: string;
  args?: Record<string, string>;
}> = {
  name: "connector.call",
  description:
    "Call an action on an installed connector. Arguments must match the connector's catalogue. Credentials are injected server-side and never returned.",
  inputSchema: z.object({
    slug: z.string().max(60),
    action: z.string().max(60),
    args: z
      .record(z.string(), z.string())
      .refine((value) => Object.keys(value).length <= 20, { message: "too many args" })
      .optional(),
  }),
  requiredPermission: PERMISSIONS.CONNECTOR_USE,
  risk: "MEDIUM",
  async execute(context, input) {
    const result = await callConnector(
      { actor: context.actor, correlationId: context.correlationId, db: context.db },
      { slug: input.slug, action: input.action, agentId: context.agentId ?? null, args: input.args ?? {} },
    );
    if (!result.ok) {
      throw validationError(`Connector '${input.slug}' action '${input.action}' returned HTTP ${String(result.status)}`);
    }
    return {
      data: { status: result.status, data: result.data, durationMs: result.durationMs },
      summary: `${input.slug}.${input.action} -> HTTP ${String(result.status)} in ${result.durationMs}ms`,
    };
  },
};

export const connectorTools = [connectorListTool, connectorGetTool, connectorCallTool];
