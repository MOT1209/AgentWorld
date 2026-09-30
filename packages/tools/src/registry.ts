/**
 * Tool registry.
 *
 * Construction validates every tool's static contract: unique name, a
 * well-formed dotted name, a declared permission that exists in the catalogue,
 * and a coherent risk/approval pairing. A malformed tool fails at boot rather
 * than at the moment an agent invokes it in production.
 */
import { validationError, isValidToolName } from "../../shared/src/index.js";
import { isDeclarableToolPermission, type Permission } from "../../security/src/permissions.js";
import { zodToJsonSchema } from "../../ai/src/json-schema.js";
import type { AnyToolDefinition, ToolDefinition, ToolSpec } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  constructor(tools: AnyToolDefinition[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw validationError(`Duplicate tool name '${tool.name}'`);
    }
    validateTool(tool);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: AnyToolDefinition[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition<never> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw validationError(
        `Unknown tool '${name}'. Registered tools: ${this.names().join(", ")}`,
      );
    }
    return tool as ToolDefinition<never>;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  all(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** Full catalogue with schemas, for the dashboard's tool inspector. */
  catalogue(): Array<ToolSpec & Pick<ToolDefinition<never>, "requiredPermission" | "risk">> {
    return this.all().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.inputSchema),
      requiredPermission: tool.requiredPermission,
      risk: tool.risk,
    }));
  }

  /**
   * Tools visible to a caller: intersect the role allow-list with the
   * permissions the caller actually holds. An agent is never even shown a tool
   * it could not use, which keeps prompts honest and avoids tempting the model
   * into denied calls.
   */
  specsFor(permissions: ReadonlySet<Permission>, allowedTools: string[] | "*"): ToolSpec[] {
    const allowAll = allowedTools === "*";
    return this.all()
      .filter((tool) => permissions.has(tool.requiredPermission))
      .filter((tool) => allowAll || allowedTools.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.inputSchema),
      }));
  }
}

function validateTool(tool: AnyToolDefinition): void {
  if (!isValidToolName(tool.name)) {
    throw validationError(
      `Tool name '${tool.name}' must be dotted lowercase, e.g. 'wallet.transfer'`,
    );
  }
  if (typeof tool.description !== "string" || tool.description.trim().length < 10) {
    throw validationError(`Tool '${tool.name}' needs a meaningful description for the model`);
  }
  if (!isDeclarableToolPermission(tool.requiredPermission)) {
    throw validationError(
      `Tool '${tool.name}' requires unknown permission '${tool.requiredPermission}'`,
    );
  }
  if (tool.agentOnly === true && tool.humanOnly === true) {
    throw validationError(`Tool '${tool.name}' cannot be both agent-only and human-only`);
  }
  // Converting the schema at registration time surfaces an unsupported Zod
  // construct immediately, instead of when a provider is asked to advertise it.
  zodToJsonSchema(tool.inputSchema);
}
