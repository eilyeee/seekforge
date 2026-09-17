/**
 * Pure model for the agent create/edit form. The server renders and validates
 * the file (with core's parser and loader); this only turns form fields into
 * the draft payload and back.
 */
import type { AgentDefinitionDraft, AgentDefinitionScope, AgentDefinitionSource, AgentInfo } from "../types";

/** Mirrors the server's id check so the form can explain it before saving. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXTRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORM_KEYS = new Set(["name", "description", "tools", "mode", "model", "max-turns"]);

export type AgentEditorForm = {
  id: string;
  scope: AgentDefinitionScope;
  name: string;
  description: string;
  /** Off = every tool; on = only the comma-separated `tools`. */
  restrictTools: boolean;
  tools: string;
  mode: "ask" | "edit";
  model: string;
  maxTurns: string;
  body: string;
  /** Other frontmatter entries as raw YAML value text (kept verbatim when untouched). */
  extra: Array<{ key: string; value: string }>;
};

export function emptyAgentForm(scope: AgentDefinitionScope = "project"): AgentEditorForm {
  return {
    id: "",
    scope,
    name: "",
    description: "",
    restrictTools: false,
    tools: "",
    mode: "edit",
    model: "",
    maxTurns: "",
    body: "",
    extra: [],
  };
}

export function formFromSource(source: AgentDefinitionSource): AgentEditorForm {
  return {
    id: source.id,
    scope: source.scope,
    name: source.name,
    description: source.description,
    restrictTools: source.tools !== null,
    tools: (source.tools ?? []).join(", "),
    mode: source.mode,
    model: source.model,
    maxTurns: source.maxTurns === null ? "" : String(source.maxTurns),
    body: source.body,
    extra: source.extra.map((field) => ({ ...field })),
  };
}

/**
 * A project copy of a loaded definition (e.g. to override a builtin). The
 * loader's optional prose fields travel as extra entries in canonical form.
 */
export function formFromDefinition(def: AgentInfo & { body?: string }): AgentEditorForm {
  const extra: AgentEditorForm["extra"] = [];
  if (def.triggers.length > 0) extra.push({ key: "trigger", value: JSON.stringify(def.triggers.join(" | ")) });
  for (const [key, value] of [
    ["own", def.own],
    ["do_not_touch", def.doNotTouch],
    ["boundary", def.boundary],
  ] as const) {
    if (value) extra.push({ key, value: JSON.stringify(value) });
  }
  return {
    ...emptyAgentForm("project"),
    id: def.id,
    name: def.name,
    description: def.description,
    restrictTools: def.tools !== undefined,
    tools: (def.tools ?? []).join(", "),
    mode: def.mode,
    model: def.model ?? "",
    maxTurns: def.maxTurns === undefined ? "" : String(def.maxTurns),
    body: def.body ?? "",
    extra,
  };
}

export type AgentFormError = "id" | "maxTurns" | "tools" | "extraKey" | "extraDuplicate";

export function draftFromForm(
  form: AgentEditorForm,
): { ok: true; draft: AgentDefinitionDraft } | { ok: false; error: AgentFormError } {
  if (!AGENT_ID_PATTERN.test(form.id)) return { ok: false, error: "id" };
  let maxTurns: number | null = null;
  if (form.maxTurns.trim() !== "") {
    const parsed = Number(form.maxTurns.trim());
    if (!/^[1-9]\d*$/.test(form.maxTurns.trim()) || !Number.isSafeInteger(parsed))
      return { ok: false, error: "maxTurns" };
    maxTurns = parsed;
  }
  const tools = form.tools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools.some((tool) => !/^[A-Za-z0-9_.:*-]{1,128}$/.test(tool))) return { ok: false, error: "tools" };
  const extra: AgentDefinitionDraft["extra"] = [];
  const seen = new Set<string>();
  for (const field of form.extra) {
    const key = field.key.trim();
    if (key === "") continue;
    if (!EXTRA_KEY_PATTERN.test(key)) return { ok: false, error: "extraKey" };
    const folded = key.toLowerCase();
    if (FORM_KEYS.has(folded) || seen.has(folded)) return { ok: false, error: "extraDuplicate" };
    seen.add(folded);
    extra.push({ key, value: field.value });
  }
  return {
    ok: true,
    draft: {
      name: form.name.trim(),
      description: form.description.trim(),
      tools: form.restrictTools ? [...new Set(tools)] : null,
      mode: form.mode,
      model: form.model.trim(),
      maxTurns,
      body: form.body,
      extra,
    },
  };
}
