/**
 * Minimal Zod -> JSON Schema converter.
 *
 * Tools must be advertised to providers as JSON Schema but validated at
 * execution with Zod. Rather than depend on a conversion library (and pin a
 * Zod major version to it), this covers the subset the tool schemas actually
 * use: object/string/number/boolean/enum/array/optional/nullable/default/
 * literal/record/union plus `.describe()`.
 *
 * Unsupported constructs fail loudly rather than emitting a schema that would
 * silently misrepresent a tool to the model.
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
}

function describeOf(schema: ZodTypeAny): string | undefined {
  const description = schema.description;
  return typeof description === "string" && description.length > 0 ? description : undefined;
}

function unsupported(path: string, schema: ZodTypeAny): never {
  throw new Error(
    `Cannot convert ${schema.constructor.name} at '${path || "<root>"}' to JSON Schema. ` +
      `Simplify the tool schema; provider contracts require JSON Schema.`,
  );
}

export function zodToJsonSchema(schema: ZodTypeAny, path = ""): JsonSchema {
  const description = describeOf(schema);
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const typeName = def.typeName as string | undefined;

  const withDescription = (result: JsonSchema): JsonSchema =>
    description !== undefined ? { ...result, description } : result;

  switch (typeName) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value, path ? `${path}.${key}` : key);
        if (!isOptionalZodType(value)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      const catchall = def.catchall as ZodTypeAny | undefined;
      if (catchall && (catchall as { _def?: { typeName?: string } })._def?.typeName !== "ZodNever") {
        out.additionalProperties = zodToJsonSchema(catchall, `${path}.*`);
      } else {
        out.additionalProperties = false;
      }
      return withDescription(out);
    }
    case "ZodString":
      return withDescription({ type: "string" });
    case "ZodNumber":
      return withDescription({ type: "number" });
    case "ZodBoolean":
      return withDescription({ type: "boolean" });
    case "ZodEnum":
      return withDescription({ type: "string", enum: [...(def.values as string[])] });
    case "ZodNativeEnum": {
      const values = Object.values(def.values as Record<string, string | number>);
      return withDescription({ type: typeof values[0] === "number" ? "number" : "string", enum: values });
    }
    case "ZodLiteral":
      return withDescription({ const: def.value });
    case "ZodArray":
      return withDescription({
        type: "array",
        items: zodToJsonSchema(def.type as ZodTypeAny, `${path}[]`),
      });
    case "ZodOptional":
    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, path);
      return withDescription(description !== undefined ? { ...inner, description } : inner);
    }
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, path);
      const defaultValue = (def.defaultValue as () => unknown)();
      return withDescription({ ...inner, default: defaultValue });
    }
    case "ZodEffects":
      return zodToJsonSchema(def.schema as ZodTypeAny, path);
    case "ZodRecord":
      return withDescription({
        type: "object",
        additionalProperties: zodToJsonSchema(def.valueType as ZodTypeAny, `${path}.*`),
      });
    case "ZodUnion": {
      const options = def.options as ZodTypeAny[];
      return withDescription({ anyOf: options.map((o, i) => zodToJsonSchema(o, `${path}|${i}`)) });
    }
    case "ZodAny":
    case "ZodUnknown":
      return withDescription({});
    default:
      return unsupported(path, schema);
  }
}

function isOptionalZodType(schema: ZodTypeAny): boolean {
  const typeName = (schema as unknown as { _def: { typeName?: string } })._def.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

/** Convenience for tool authors. */
export const jsonSchemaOf = zodToJsonSchema;
export type { ZodTypeAny };
export { z };
