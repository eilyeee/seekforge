import type { z } from "zod";

/**
 * Minimal zod -> JSON Schema converter for the subset used by built-in tools:
 * object / string / number / boolean / array / enum / optional / default / describe,
 * including the length and numeric bounds used by built-in tools.
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
    case "ZodString": {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      const min = checks.find((check) => check.kind === "min")?.value;
      const max = checks.find((check) => check.kind === "max")?.value;
      return {
        ...out,
        type: "string",
        ...(min !== undefined ? { minLength: min } : {}),
        ...(max !== undefined ? { maxLength: max } : {}),
      };
    }
    case "ZodNumber": {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; inclusive?: boolean }>;
      const min = checks.find((check) => check.kind === "min");
      const max = checks.find((check) => check.kind === "max");
      return {
        ...out,
        type: checks.some((check) => check.kind === "int") ? "integer" : "number",
        ...(min?.value !== undefined
          ? min.inclusive === false
            ? { exclusiveMinimum: min.value }
            : { minimum: min.value }
          : {}),
        ...(max?.value !== undefined
          ? max.inclusive === false
            ? { exclusiveMaximum: max.value }
            : { maximum: max.value }
          : {}),
      };
    }
    case "ZodBoolean":
      return { ...out, type: "boolean" };
    case "ZodArray":
      return {
        ...out,
        type: "array",
        items: zodToJsonSchema(def.type),
        ...(def.minLength?.value !== undefined ? { minItems: def.minLength.value } : {}),
        ...(def.maxLength?.value !== undefined ? { maxItems: def.maxLength.value } : {}),
        ...(def.exactLength?.value !== undefined
          ? { minItems: def.exactLength.value, maxItems: def.exactLength.value }
          : {}),
      };
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
