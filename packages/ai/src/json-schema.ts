/**
 * Zod -> JSON Schema for tool definitions.
 *
 * Tools must be advertised to providers as JSON Schema but validated at
 * execution with Zod. Zod 4 converts its own schemas (`z.toJSONSchema`), so this
 * wraps that and keeps the contract the providers and tests rely on:
 *
 *  - no `$schema` keyword;
 *  - every object with declared properties is closed (`additionalProperties: false`);
 *  - record keys are not advertised (`propertyNames` is dropped);
 *  - constructs that have no JSON Schema form fail loudly rather than emitting a
 *    schema that would silently misrepresent a tool to the model.
 */
import { z, type ZodTypeAny } from "zod";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** Closes objects and drops the keywords providers do not need, in place. */
function normalise(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) normalise(entry);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  delete schema.propertyNames;
  if (schema.properties !== undefined && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  for (const value of Object.values(schema)) normalise(value);
}

export function zodToJsonSchema(schema: ZodTypeAny, path = ""): JsonSchema {
  let converted: Record<string, unknown>;
  try {
    // "input": what the model must send, so a defaulted field is optional.
    converted = z.toJSONSchema(schema, { io: "input", unrepresentable: "throw" }) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot convert ${schema.constructor.name} at '${path || "<root>"}' to JSON Schema (${reason}). ` +
        `Simplify the tool schema; provider contracts require JSON Schema.`,
    );
  }
  delete converted.$schema;
  normalise(converted);
  return converted as JsonSchema;
}

/** Convenience for tool authors. */
export const jsonSchemaOf = zodToJsonSchema;
export type { ZodTypeAny };
export { z };
