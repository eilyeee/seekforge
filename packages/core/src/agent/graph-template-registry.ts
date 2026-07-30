import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { isDeepStrictEqual } from "node:util";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import {
  GRAPH_TEMPLATE_VERSION_RE,
  parseEngineeringGraphTemplate,
  type EngineeringGraphTemplate,
} from "./graph-template.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { isDenseArray } from "./orchestration.js";
import { acquireSessionLease } from "./session-lease.js";

export type RegisteredEngineeringGraphTemplate = {
  template: EngineeringGraphTemplate;
  registeredAt: string;
  deprecatedAt?: string;
};

export type EngineeringGraphTemplateCompatibility = {
  templateId: string;
  fromVersion: string;
  toVersion: string;
  classification: "identical" | "compatible" | "breaking";
  reasons: string[];
};

const REGISTRY_PATH = ".seekforge/graph-template-registry.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_REGISTERED_TEMPLATES = 64;

function compareTemplateVersions(left: string, right: string): number {
  const splitVersion = (value: string): [string, string | undefined] => {
    const separator = value.indexOf("-");
    return separator < 0 ? [value, undefined] : [value.slice(0, separator), value.slice(separator + 1)];
  };
  const [leftCore, leftPrerelease] = splitVersion(left);
  const [rightCore, rightPrerelease] = splitVersion(right);
  const leftNumbers = leftCore.split(".").map(Number);
  const rightNumbers = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (leftNumbers[index] !== rightNumbers[index]) return leftNumbers[index]! < rightNumbers[index]! ? -1 : 1;
  }
  if (leftPrerelease === undefined || rightPrerelease === undefined) {
    return leftPrerelease === rightPrerelease ? 0 : leftPrerelease === undefined ? 1 : -1;
  }
  const leftParts = leftPrerelease.split(".");
  const rightParts = rightPrerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const normalizedLeft = leftPart.replace(/^0+/, "") || "0";
      const normalizedRight = rightPart.replace(/^0+/, "") || "0";
      if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length < normalizedRight.length ? -1 : 1;
      }
      if (normalizedLeft === normalizedRight) continue;
      return normalizedLeft < normalizedRight ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function listEngineeringGraphTemplates(workspace: string): RegisteredEngineeringGraphTemplate[] {
  try {
    const raw = readWorkspaceStateFile(workspace, REGISTRY_PATH, MAX_REGISTRY_BYTES);
    if (raw === undefined) return [];
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "templates"]) ||
      (value.version !== 1 && value.version !== 2) ||
      !isDenseArray(value.templates) ||
      value.templates.length > MAX_REGISTERED_TEMPLATES
    ) {
      return [];
    }
    const templates = value.templates.flatMap((entry): RegisteredEngineeringGraphTemplate[] => {
      if (
        !isRecord(entry) ||
        !hasOnlyKeys(entry, ["template", "registeredAt", "deprecatedAt"]) ||
        typeof entry.registeredAt !== "string" ||
        !Number.isFinite(Date.parse(entry.registeredAt)) ||
        (entry.deprecatedAt !== undefined &&
          (typeof entry.deprecatedAt !== "string" || !Number.isFinite(Date.parse(entry.deprecatedAt))))
      ) {
        return [];
      }
      try {
        const template = parseEngineeringGraphTemplate(entry.template);
        if (template.schemaVersion !== 2) return [];
        return [
          {
            template,
            registeredAt: entry.registeredAt,
            ...(typeof entry.deprecatedAt === "string" ? { deprecatedAt: entry.deprecatedAt } : {}),
          },
        ];
      } catch {
        return [];
      }
    });
    if (templates.length !== value.templates.length) return [];
    const keys = templates.map((entry) => `${entry.template.templateId}@${entry.template.version}`);
    return new Set(keys).size === keys.length ? templates : [];
  } catch {
    return [];
  }
}

export function registerEngineeringGraphTemplate(
  workspace: string,
  input: unknown,
): RegisteredEngineeringGraphTemplate {
  const template = parseEngineeringGraphTemplate(input);
  if (template.schemaVersion !== 2 || !template.version) {
    throw new Error("Registered Graph templates require schemaVersion 2 and a semantic version");
  }
  const lease = acquireSessionLease(workspace, "graph-template-registry");
  try {
    // The lease covers read-modify-write so independent server processes cannot
    // silently overwrite each other's newly registered versions.
    const existing = listEngineeringGraphTemplates(workspace);
    const key = `${template.templateId}@${template.version}`;
    const previous = existing.find((item) => `${item.template.templateId}@${item.template.version}` === key);
    const entry = {
      template,
      registeredAt: new Date().toISOString(),
      ...(previous?.deprecatedAt ? { deprecatedAt: previous.deprecatedAt } : {}),
    };
    const templates = [
      ...existing.filter((item) => `${item.template.templateId}@${item.template.version}` !== key),
      entry,
    ];
    if (templates.length > MAX_REGISTERED_TEMPLATES) throw new Error("Graph template registry is full");
    const serialized = `${JSON.stringify({ version: 2, templates })}\n`;
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) throw new Error("Graph template registry is too large");
    writeWorkspaceStateFileAtomic(workspace, REGISTRY_PATH, serialized);
    return entry;
  } finally {
    lease.release();
  }
}

export function compareEngineeringGraphTemplates(
  beforeInput: unknown,
  afterInput: unknown,
): EngineeringGraphTemplateCompatibility {
  const before = parseEngineeringGraphTemplate(beforeInput);
  const after = parseEngineeringGraphTemplate(afterInput);
  if (before.schemaVersion !== 2 || after.schemaVersion !== 2 || !before.version || !after.version) {
    throw new Error("Graph template compatibility requires versioned schemaVersion 2 templates");
  }
  if (before.templateId !== after.templateId) throw new Error("Graph template comparison requires matching ids");
  const reasons: string[] = [];
  for (const [name, parameter] of Object.entries(before.parameters)) {
    const next = after.parameters[name];
    if (!next) reasons.push(`removed parameter: ${name}`);
    else if (next.type !== parameter.type) reasons.push(`changed parameter type: ${name}`);
    else if (parameter.default !== undefined && next.default === undefined)
      reasons.push(`removed parameter default: ${name}`);
  }
  for (const [name, parameter] of Object.entries(after.parameters)) {
    if (!before.parameters[name] && parameter.default === undefined) reasons.push(`added required parameter: ${name}`);
  }
  if (!isDeepStrictEqual(before.interface, after.interface)) reasons.push("changed output interface");
  const identical = isDeepStrictEqual(
    { parameters: before.parameters, interface: before.interface, definition: before.definition },
    { parameters: after.parameters, interface: after.interface, definition: after.definition },
  );
  if (!identical && compareTemplateVersions(after.version, before.version) <= 0) {
    reasons.push("version does not advance");
  }
  return {
    templateId: before.templateId,
    fromVersion: before.version,
    toVersion: after.version,
    classification: identical ? "identical" : reasons.length > 0 ? "breaking" : "compatible",
    reasons,
  };
}

export function deprecateEngineeringGraphTemplate(
  workspace: string,
  templateId: string,
  version: string,
): RegisteredEngineeringGraphTemplate {
  if (!isValidLoopDagId(templateId) || !GRAPH_TEMPLATE_VERSION_RE.test(version)) {
    throw new Error("Graph template reference is invalid");
  }
  const lease = acquireSessionLease(workspace, "graph-template-registry");
  try {
    const templates = listEngineeringGraphTemplates(workspace);
    const index = templates.findIndex(
      (entry) => entry.template.templateId === templateId && entry.template.version === version,
    );
    if (index < 0) throw new Error(`Graph template not found: ${templateId}@${version}`);
    const updated = templates[index]!.deprecatedAt
      ? templates[index]!
      : { ...templates[index]!, deprecatedAt: new Date().toISOString() };
    templates[index] = updated;
    const serialized = `${JSON.stringify({ version: 2, templates })}\n`;
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) throw new Error("Graph template registry is too large");
    writeWorkspaceStateFileAtomic(workspace, REGISTRY_PATH, serialized);
    return updated;
  } finally {
    lease.release();
  }
}

export function resolveEngineeringGraphTemplate(
  workspace: string,
  templateId: string,
  version: string,
): EngineeringGraphTemplate | undefined {
  if (!isValidLoopDagId(templateId) || !GRAPH_TEMPLATE_VERSION_RE.test(version)) {
    throw new Error("Graph template reference is invalid");
  }
  return listEngineeringGraphTemplates(workspace).find(
    (entry) => entry.template.templateId === templateId && entry.template.version === version,
  )?.template;
}
