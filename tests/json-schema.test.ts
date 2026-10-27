import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../packages/ai/src/json-schema.js";

// Tool schemas are advertised to model providers as JSON Schema. The converter
// wraps Zod's own `z.toJSONSchema`; these tests pin the parts of the contract
// the providers and the executor rely on.

describe("zodToJsonSchema", () => {
  const schema = z.object({
    name: z.string().describe("Who"),
    limit: z.number().int().min(1).max(5).default(3),
    kind: z.enum(["A", "B"]).optional(),
    tags: z.array(z.string().max(5)).max(3),
    meta: z.record(z.string(), z.unknown()),
    note: z.string().nullable(),
    nested: z.object({ id: z.string() }),
  });

  it("describes fields, defaults, enums, arrays and nullable values", () => {
    const out = zodToJsonSchema(schema);
    expect(out.type).toBe("object");
    expect(out.properties?.name).toEqual({ type: "string", description: "Who" });
    expect(out.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 5, default: 3 });
    expect(out.properties?.kind).toMatchObject({ type: "string", enum: ["A", "B"] });
    expect(out.properties?.tags).toMatchObject({ type: "array", maxItems: 3, items: { type: "string", maxLength: 5 } });
    expect(out.properties?.note?.type).toEqual(["string", "null"]);
  });

  it("marks only fields without a default or optional wrapper as required", () => {
    expect(zodToJsonSchema(schema).required).toEqual(["name", "tags", "meta", "note", "nested"]);
  });

  it("closes objects at every level and drops $schema and propertyNames", () => {
    const out = zodToJsonSchema(schema);
    expect(out).not.toHaveProperty("$schema");
    expect(out.additionalProperties).toBe(false);
    expect(out.properties?.nested?.additionalProperties).toBe(false);
    expect(out.properties?.meta).not.toHaveProperty("propertyNames");
    expect(out.properties?.meta?.type).toBe("object");
  });

  it("fails loudly on a construct with no JSON Schema form", () => {
    expect(() => zodToJsonSchema(z.object({ when: z.date() }))).toThrow(/Cannot convert .* to JSON Schema/);
  });
});
