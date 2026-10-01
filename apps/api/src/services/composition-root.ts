import { createDefaultRegistry, ToolExecutor } from "../../../../packages/tools/src/index.js";
import type { ToolInvoker } from "../../../../packages/agents/src/runtime.js";
import { getProviderRegistry } from "../../../../packages/ai/src/index.js";

export const toolRegistry = createDefaultRegistry();
export const toolExecutor = new ToolExecutor({ registry: toolRegistry });

export const invoker: ToolInvoker = {
  listSpecs: (perms, allowed) => toolExecutor.listSpecs(perms, allowed),
  invoke: (name, args, ctx) => toolExecutor.invoke(name, args, ctx),
};

export function getCompositionRoot(): {
  toolRegistry: typeof toolRegistry;
  toolExecutor: typeof toolExecutor;
  invoker: ToolInvoker;
  providerRegistry: ReturnType<typeof getProviderRegistry>;
} {
  return {
    toolRegistry,
    toolExecutor,
    invoker,
    providerRegistry: getProviderRegistry(),
  };
}
