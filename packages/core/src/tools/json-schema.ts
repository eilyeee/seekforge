import type { z } from "zod";

/**
 * Minimal zod -> JSON Schema converter for the subset used by built-in tools:
 * object / string / number / boolean / array / enum / optional / default / describe.
 * Intentionally NOT a general-purpose converter (no extra dependency).
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;
  const out: Record<string, unknown> = {};
  if (schema.description) out.description = schema.description;

  switch (def.typeName as string) {
    case "ZodObject": {
      const shape = def.shape() as Record<string, z.ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return {
        ...out,
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    case "ZodString":
      return { ...out, type: "string" };
    case "ZodNumber":
      return { ...out, type: def.checks?.some((c: { kind: string }) => c.kind === "int") ? "integer" : "number" };
    case "ZodBoolean":
      return { ...out, type: "boolean" };
    case "ZodArray":
      return { ...out, type: "array", items: zodToJsonSchema(def.type) };
    case "ZodEnum":
      return { ...out, type: "string", enum: [...def.values] };
    case "ZodOptional":
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType);
      // Outer .describe() wins over the inner one.
      return { ...inner, ...out };
    }
    default:
      return out; // unsupported -> permissive empty schema
  }
}
