import { isRecord } from "../util/guards.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import {
  type EngineeringGraphDefinition,
  MAX_GRAPH_DEFINITION_BYTES,
  parseEngineeringGraphDefinition,
} from "./graph-contract.js";
import { isDenseArray } from "./orchestration.js";

export type EngineeringGraphTemplateParameter = {
  type: "string" | "number" | "boolean";
  description?: string;
  default?: string | number | boolean;
};

export type EngineeringGraphTemplate = {
  schemaVersion: 1;
  kind: "engineering-graph-template";
  templateId: string;
  parameters: Record<string, EngineeringGraphTemplateParameter>;
  definition: unknown;
};

const PLACEHOLDER_RE = /\$\{\{([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}\}/g;

function validParameterValue(value: unknown, type: EngineeringGraphTemplateParameter["type"]): boolean {
  return (
    (type === "string" && typeof value === "string" && value.length <= 64 * 1024) ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "boolean" && typeof value === "boolean")
  );
}

export function parseEngineeringGraphTemplate(value: unknown): EngineeringGraphTemplate {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "engineering-graph-template" ||
    !isValidLoopDagId(value.templateId) ||
    !isRecord(value.parameters) ||
    value.definition === undefined
  ) {
    throw new Error("Graph template requires schemaVersion 1, kind, templateId, parameters, and definition");
  }
  const entries = Object.entries(value.parameters);
  if (entries.length > 64) throw new Error("Graph template may declare at most 64 parameters");
  const parameters = Object.create(null) as Record<string, EngineeringGraphTemplateParameter>;
  for (const [name, raw] of entries) {
    if (!isValidLoopDagId(name) || !isRecord(raw) || !["string", "number", "boolean"].includes(String(raw.type))) {
      throw new Error(`Graph template parameter is invalid: ${name}`);
    }
    const type = raw.type as EngineeringGraphTemplateParameter["type"];
    if (
      (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 1024)) ||
      (raw.default !== undefined && !validParameterValue(raw.default, type))
    ) {
      throw new Error(`Graph template parameter metadata is invalid: ${name}`);
    }
    parameters[name] = {
      type,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(raw.default !== undefined ? { default: raw.default as string | number | boolean } : {}),
    };
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_GRAPH_DEFINITION_BYTES) {
    throw new Error(`Graph template exceeds ${MAX_GRAPH_DEFINITION_BYTES} bytes`);
  }
  return {
    schemaVersion: 1,
    kind: "engineering-graph-template",
    templateId: value.templateId,
    parameters,
    definition: value.definition,
  };
}

function substitute(
  value: unknown,
  parameters: Readonly<Record<string, string | number | boolean>>,
  depth = 0,
): unknown {
  if (depth > 32) throw new Error("Graph template content is too deeply nested");
  if (typeof value === "string") {
    const exact = /^\$\{\{([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}\}$/.exec(value);
    if (exact) {
      if (!Object.hasOwn(parameters, exact[1]!)) throw new Error(`Unknown Graph template placeholder: ${exact[1]}`);
      return parameters[exact[1]!]!;
    }
    const replaced = value.replace(PLACEHOLDER_RE, (_, name: string) => {
      if (!Object.hasOwn(parameters, name)) throw new Error(`Unknown Graph template placeholder: ${name}`);
      return String(parameters[name]!);
    });
    if (replaced.includes("${{")) throw new Error("Graph template contains an invalid or unresolved placeholder");
    return replaced;
  }
  if (isDenseArray(value)) return value.map((item) => substitute(item, parameters, depth + 1));
  if (isRecord(value)) {
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) result[key] = substitute(child, parameters, depth + 1);
    return result;
  }
  return value;
}

export function materializeEngineeringGraph(
  input: unknown,
  supplied: Readonly<Record<string, unknown>> = {},
): EngineeringGraphDefinition {
  if (!isRecord(input) || input.kind !== "engineering-graph-template") {
    if (Object.keys(supplied).length > 0) throw new Error("Graph parameters require an engineering-graph-template");
    return parseEngineeringGraphDefinition(input);
  }
  const template = parseEngineeringGraphTemplate(input);
  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(template.parameters, name)) throw new Error(`Unknown Graph template parameter: ${name}`);
  }
  const resolved = Object.create(null) as Record<string, string | number | boolean>;
  for (const [name, parameter] of Object.entries(template.parameters)) {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : parameter.default;
    if (value === undefined) throw new Error(`Missing Graph template parameter: ${name}`);
    if (!validParameterValue(value, parameter.type)) {
      throw new Error(`Graph template parameter ${name} must be ${parameter.type}`);
    }
    resolved[name] = value as string | number | boolean;
  }
  const definition = substitute(template.definition, resolved);
  if (Buffer.byteLength(JSON.stringify(definition)) > MAX_GRAPH_DEFINITION_BYTES) {
    throw new Error(`Materialized Graph definition exceeds ${MAX_GRAPH_DEFINITION_BYTES} bytes`);
  }
  return parseEngineeringGraphDefinition(definition);
}
