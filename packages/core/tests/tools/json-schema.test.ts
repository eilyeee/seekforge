import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../../src/tools/json-schema.js";

describe("zodToJsonSchema", () => {
  it("preserves numeric bounds and integer constraints", () => {
    expect(zodToJsonSchema(z.number().int().min(1).max(10))).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 10,
    });
    expect(zodToJsonSchema(z.number().gt(0).lt(1))).toEqual({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    });
  });

  it("preserves string and array length bounds", () => {
    expect(zodToJsonSchema(z.string().min(2).max(8))).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 8,
    });
    expect(zodToJsonSchema(z.array(z.string().min(1)).min(2).max(6))).toEqual({
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: { type: "string", minLength: 1 },
    });
  });

  it("preserves exact array lengths", () => {
    expect(zodToJsonSchema(z.array(z.boolean()).length(3))).toEqual({
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "boolean" },
    });
  });
});
