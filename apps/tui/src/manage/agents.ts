/**
 * /agents: the dispatchable subagents with their scope, a short wizard that
 * writes a new AGENT.md (core renders and validates it), and "open in $EDITOR"
 * for the ones that live in a file this user owns.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentDefinitionRelPath, type AgentDefinition, validateNewAgent } from "@seekforge/core";
import type { KeyStroke } from "../keymap.js";
import { t } from "../strings.js";
import { editLine, listDelta, type ManageMessage, moveIndex } from "./common.js";

export type AgentRow = {
  id: string;
  scope: AgentDefinition["scope"];
  mode: AgentDefinition["mode"];
  description: string;
  model?: string;
  tools?: string[];
  /** The AGENT.md this definition was read from, when it is a plain file here. */
  path?: string;
};

export type AgentScopeChoice = "project" | "global";

export type AgentDraft = {
  /** 0 id · 1 description · 2 tools · 3 mode · 4 model · 5 scope */
  field: number;
  id: string;
  description: string;
  tools: string;
  mode: "ask" | "edit";
  model: string;
  scope: AgentScopeChoice;
};

export const AGENT_DRAFT_FIELDS = 6;

export type AgentsView = {
  kind: "agents";
  rows: AgentRow[];
  index: number;
  draft?: AgentDraft;
  message?: ManageMessage;
};

export type AgentsEffect =
  | {
      kind: "create-agent";
      scope: AgentScopeChoice;
      definition: { id: string; description: string; mode: "ask" | "edit"; tools?: string[]; model?: string };
    }
  | { kind: "edit-agent"; path: string };

export type AgentsOutcome =
  | { kind: "update"; view: AgentsView }
  | { kind: "effect"; view: AgentsView; effect: AgentsEffect }
  | { kind: "close" }
  | { kind: "ignore" };

/**
 * Rows for the loaded definitions. A definition's file is only offered for
 * editing when it exists where its scope says; a plugin's agents are reported
 * as "global" by the loader but live inside the plugin.
 */
export function agentRows(defs: readonly AgentDefinition[], roots: { project: string; global: string }): AgentRow[] {
  return defs.map((def) => {
    const root = def.scope === "project" ? roots.project : def.scope === "global" ? roots.global : undefined;
    const path = root ? join(root, agentDefinitionRelPath(def.id)) : undefined;
    return {
      id: def.id,
      scope: def.scope,
      mode: def.mode,
      description: def.description,
      ...(def.model ? { model: def.model } : {}),
      ...(def.tools ? { tools: def.tools } : {}),
      ...(path && existsSync(path) ? { path } : {}),
    };
  });
}

export function agentRowLine(row: AgentRow): string {
  const flat = row.description.replace(/\s+/g, " ").trim();
  const description = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  const origin = row.scope === "global" && !row.path ? "plugin/global" : row.scope;
  return `${row.id}  (${row.mode}, ${origin})${row.model ? ` [${row.model}]` : ""}  ${description}`;
}

export function agentRowDetail(row: AgentRow): string {
  const tools = row.tools ? row.tools.join(", ") : t("manage.agents.allTools");
  return `${t("manage.agents.tools")} ${tools}${row.path ? ` · ${row.path}` : ""}`;
}

function draftDefinition(draft: AgentDraft): AgentsEffect & { kind: "create-agent" } {
  const tools = draft.tools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const model = draft.model.trim();
  return {
    kind: "create-agent",
    scope: draft.scope,
    definition: {
      id: draft.id.trim(),
      description: draft.description.trim(),
      mode: draft.mode,
      ...(tools.length > 0 ? { tools } : {}),
      ...(model ? { model } : {}),
    },
  };
}

const TEXT_FIELDS: Record<number, "id" | "description" | "tools" | "model"> = {
  0: "id",
  1: "description",
  2: "tools",
  4: "model",
};

export function agentsKey(view: AgentsView, input: string, stroke: KeyStroke): AgentsOutcome {
  const draft = view.draft;
  if (draft) {
    const { draft: _closed, ...closed } = view;
    if (stroke.name === "escape") {
      return { kind: "update", view: { ...closed, message: { text: t("manage.cancelled"), tone: "dim" } } };
    }
    if (stroke.name === "return") {
      const effect = draftDefinition(draft);
      const problem = validateNewAgent(effect.definition);
      if (problem) return { kind: "update", view: { ...view, message: { text: problem, tone: "error" } } };
      if (view.rows.some((row) => row.id === effect.definition.id && row.scope === draft.scope)) {
        return { kind: "update", view: { ...view, message: { text: t("manage.agents.exists"), tone: "error" } } };
      }
      return { kind: "effect", view: closed, effect };
    }
    if (stroke.name === "tab" || stroke.name === "down" || stroke.name === "up") {
      const back = stroke.name === "up" || (stroke.name === "tab" && stroke.shift === true);
      const field = moveIndex(draft.field, back ? -1 : 1, AGENT_DRAFT_FIELDS);
      return { kind: "update", view: { ...view, draft: { ...draft, field } } };
    }
    const toggle = stroke.name === "left" || stroke.name === "right" || input === " ";
    if (draft.field === 3 && toggle) {
      return { kind: "update", view: { ...view, draft: { ...draft, mode: draft.mode === "ask" ? "edit" : "ask" } } };
    }
    if (draft.field === 5 && toggle) {
      const scope: AgentScopeChoice = draft.scope === "project" ? "global" : "project";
      return { kind: "update", view: { ...view, draft: { ...draft, scope } } };
    }
    const key = TEXT_FIELDS[draft.field];
    if (key) {
      // Ids are kebab-case; lowercase as the user types instead of rejecting later.
      const typed = key === "id" ? input.toLowerCase() : input;
      const next = editLine(draft[key], typed, stroke, key === "description" ? 300 : 120);
      if (next !== undefined) return { kind: "update", view: { ...view, draft: { ...draft, [key]: next } } };
    }
    return { kind: "ignore" };
  }

  const delta = listDelta(stroke);
  if (delta !== undefined)
    return { kind: "update", view: { ...view, index: moveIndex(view.index, delta, view.rows.length) } };
  if (stroke.name === "escape") return { kind: "close" };
  if (stroke.ctrl || stroke.meta) return { kind: "ignore" };
  if (input === "n") {
    const draft: AgentDraft = {
      field: 0,
      id: "",
      description: "",
      tools: "",
      mode: "edit",
      model: "",
      scope: "project",
    };
    const { message: _cleared, ...rest } = view;
    return { kind: "update", view: { ...rest, draft } };
  }
  const row = view.rows[view.index];
  if (input === "e" || stroke.name === "return") {
    if (!row) return { kind: "ignore" };
    if (!row.path) {
      const text = row.scope === "builtin" ? t("manage.agents.builtin") : t("manage.agents.noFile");
      return { kind: "update", view: { ...view, message: { text, tone: "error" } } };
    }
    return { kind: "effect", view, effect: { kind: "edit-agent", path: row.path } };
  }
  return { kind: "ignore" };
}
