import { isRecord } from "../util/guards.js";
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
};

const REGISTRY_PATH = ".seekforge/graph-template-registry.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_REGISTERED_TEMPLATES = 64;

export function listEngineeringGraphTemplates(workspace: string): RegisteredEngineeringGraphTemplate[] {
  try {
    const raw = readWorkspaceStateFile(workspace, REGISTRY_PATH, MAX_REGISTRY_BYTES);
    if (raw === undefined) return [];
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isDenseArray(value.templates) ||
      value.templates.length > MAX_REGISTERED_TEMPLATES
    ) {
      return [];
    }
    const templates = value.templates.flatMap((entry): RegisteredEngineeringGraphTemplate[] => {
      if (
        !isRecord(entry) ||
        typeof entry.registeredAt !== "string" ||
        !Number.isFinite(Date.parse(entry.registeredAt))
      ) {
        return [];
      }
      try {
        const template = parseEngineeringGraphTemplate(entry.template);
        if (template.schemaVersion !== 2) return [];
        return [{ template, registeredAt: entry.registeredAt }];
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
    const entry = { template, registeredAt: new Date().toISOString() };
    const templates = [
      ...existing.filter((item) => `${item.template.templateId}@${item.template.version}` !== key),
      entry,
    ];
    if (templates.length > MAX_REGISTERED_TEMPLATES) throw new Error("Graph template registry is full");
    const serialized = `${JSON.stringify({ version: 1, templates })}\n`;
    if (Buffer.byteLength(serialized) > MAX_REGISTRY_BYTES) throw new Error("Graph template registry is too large");
    writeWorkspaceStateFileAtomic(workspace, REGISTRY_PATH, serialized);
    return entry;
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
