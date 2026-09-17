/**
 * /permissions: every rule that applies, labelled with the layer it came from,
 * plus this session's grants; add a rule to the user or project file, delete
 * one. The project file may only tighten — core strips its allow rules on load,
 * so the editor refuses to write one there and marks existing ones as ignored.
 */

import type { PermissionRule } from "@seekforge/shared";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "../bounded-file.js";
import type { KeyStroke } from "../keymap.js";
import {
  describeRule,
  isPermissionRule,
  projectConfigPath,
  readRulesFile,
  type RuleScope,
  userConfigPath,
} from "../permission-store.js";
import { t } from "../strings.js";
import { editLine, listDelta, type ManageMessage, moveIndex } from "./common.js";

export type RuleSource = "settings" | "profile" | "project" | "user";

export type PermissionRow =
  | {
      kind: "rule";
      source: RuleSource;
      path: string;
      rule: PermissionRule;
      /** A project allow rule: kept in the file, dropped by the loader. */
      ignored?: boolean;
    }
  | { kind: "grant"; prefix: string }
  | { kind: "problem"; path: string; error: string };

const ACTIONS: ReadonlyArray<PermissionRule["action"]> = ["deny", "ask", "allow"];

export type RuleDraft = {
  /** 0 tool · 1 action · 2 match · 3 scope */
  field: number;
  tool: string;
  action: PermissionRule["action"];
  match: string;
  scope: RuleScope;
};

export const DRAFT_FIELDS = 4;

export type PermissionsView = {
  kind: "permissions";
  rows: PermissionRow[];
  index: number;
  draft?: RuleDraft;
  /** The selected rule is waiting for a `y` to be deleted. */
  confirmDelete?: boolean;
  message?: ManageMessage;
};

export type PermissionsEffect =
  | { kind: "add-rule"; scope: RuleScope; rule: PermissionRule }
  | { kind: "delete-rule"; scope: RuleScope; rule: PermissionRule };

export type PermissionsOutcome =
  | { kind: "update"; view: PermissionsView }
  | { kind: "effect"; view: PermissionsView; effect: PermissionsEffect }
  | { kind: "close" }
  | { kind: "ignore" };

export type PermissionSources = {
  projectPath: string;
  home?: string;
  settingsPath?: string;
  profile?: string;
  /** Command prefixes granted with "a" this session. */
  sessionGrants: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileRules(path: string, profile: string): PermissionRule[] {
  try {
    const doc: unknown = JSON.parse(readTextFileBounded(path, MAX_CONFIG_FILE_BYTES));
    const profiles = isRecord(doc) ? doc["profiles"] : undefined;
    const selected = isRecord(profiles) ? profiles[profile] : undefined;
    const rules = isRecord(selected) ? selected["permissionRules"] : undefined;
    return Array.isArray(rules) ? rules.filter(isPermissionRule) : [];
  } catch {
    return [];
  }
}

/** Rows in precedence order: the layer that wins first, session grants last. */
export function loadPermissionRows(sources: PermissionSources): PermissionRow[] {
  const rows: PermissionRow[] = [];
  const addFile = (source: RuleSource, path: string, repository: boolean): void => {
    const { rules, error } = readRulesFile(path);
    if (error) rows.push({ kind: "problem", path, error });
    for (const rule of rules) {
      rows.push({
        kind: "rule",
        source,
        path,
        rule,
        ...(repository && rule.action === "allow" ? { ignored: true } : {}),
      });
    }
  };
  if (sources.settingsPath) addFile("settings", sources.settingsPath, false);
  const project = projectConfigPath(sources.projectPath);
  const user = userConfigPath(sources.home);
  if (sources.profile) {
    for (const rule of profileRules(project, sources.profile)) {
      rows.push({
        kind: "rule",
        source: "profile",
        path: project,
        rule,
        ...(rule.action === "allow" ? { ignored: true } : {}),
      });
    }
    for (const rule of profileRules(user, sources.profile))
      rows.push({ kind: "rule", source: "profile", path: user, rule });
  }
  addFile("project", project, true);
  addFile("user", user, false);
  for (const prefix of sources.sessionGrants) rows.push({ kind: "grant", prefix });
  return rows;
}

export function permissionRowLine(row: PermissionRow): string {
  if (row.kind === "grant")
    return `${"session".padEnd(8)} allow run_command: ${row.prefix} ${t("manage.perm.grantNote")}`;
  if (row.kind === "problem") return `${"error".padEnd(8)} ${row.path}: ${row.error}`;
  const note = row.ignored ? ` ${t("manage.perm.ignored")}` : "";
  return `${row.source.padEnd(8)} ${describeRule(row.rule)}${note}`;
}

function editableScope(row: PermissionRow | undefined): RuleScope | undefined {
  if (row?.kind !== "rule") return undefined;
  return row.source === "user" || row.source === "project" ? row.source : undefined;
}

export function draftError(draft: RuleDraft): string | undefined {
  if (draft.tool.trim() === "") return t("manage.perm.needTool");
  if (draft.scope === "project" && draft.action === "allow") return t("manage.perm.projectAllow");
  return undefined;
}

function cycle<T>(values: readonly T[], current: T, delta: number): T {
  return values[moveIndex(values.indexOf(current), delta, values.length)] as T;
}

export function permissionsKey(view: PermissionsView, input: string, stroke: KeyStroke): PermissionsOutcome {
  const draft = view.draft;
  if (draft) {
    const { draft: _closed, ...closed } = view;
    if (stroke.name === "escape")
      return { kind: "update", view: { ...closed, message: { text: t("manage.cancelled"), tone: "dim" } } };
    if (stroke.name === "return") {
      const error = draftError(draft);
      if (error) return { kind: "update", view: { ...view, message: { text: error, tone: "error" } } };
      const match = draft.match.trim();
      const rule: PermissionRule = { action: draft.action, tool: draft.tool.trim(), ...(match ? { match } : {}) };
      return { kind: "effect", view: closed, effect: { kind: "add-rule", scope: draft.scope, rule } };
    }
    if (stroke.name === "tab" || stroke.name === "down" || stroke.name === "up") {
      const back = stroke.name === "up" || (stroke.name === "tab" && stroke.shift === true);
      return {
        kind: "update",
        view: { ...view, draft: { ...draft, field: moveIndex(draft.field, back ? -1 : 1, DRAFT_FIELDS) } },
      };
    }
    const choice = stroke.name === "left" ? -1 : stroke.name === "right" || input === " " ? 1 : 0;
    if (draft.field === 1 && choice !== 0) {
      return { kind: "update", view: { ...view, draft: { ...draft, action: cycle(ACTIONS, draft.action, choice) } } };
    }
    if (draft.field === 3 && choice !== 0) {
      const scope: RuleScope = draft.scope === "user" ? "project" : "user";
      return { kind: "update", view: { ...view, draft: { ...draft, scope } } };
    }
    if (draft.field === 0 || draft.field === 2) {
      const key = draft.field === 0 ? "tool" : "match";
      const next = editLine(draft[key], input, stroke, key === "tool" ? 128 : 512);
      if (next !== undefined) return { kind: "update", view: { ...view, draft: { ...draft, [key]: next } } };
    }
    return { kind: "ignore" };
  }

  const delta = listDelta(stroke);
  if (delta !== undefined) {
    const { confirmDelete: _dropped, ...rest } = view;
    return { kind: "update", view: { ...rest, index: moveIndex(view.index, delta, view.rows.length) } };
  }
  if (stroke.name === "escape") return { kind: "close" };
  const row = view.rows[view.index];
  if (view.confirmDelete) {
    const { confirmDelete: _dropped, ...rest } = view;
    const scope = editableScope(row);
    if (input === "y" && scope && row?.kind === "rule") {
      return { kind: "effect", view: rest, effect: { kind: "delete-rule", scope, rule: row.rule } };
    }
    return { kind: "update", view: { ...rest, message: { text: t("manage.cancelled"), tone: "dim" } } };
  }
  if (stroke.ctrl || stroke.meta) return { kind: "ignore" };
  if (input === "a") {
    return {
      kind: "update",
      view: { ...view, draft: { field: 0, tool: "", action: "deny", match: "", scope: "user" }, message: undefined },
    };
  }
  if (input === "d" || stroke.name === "delete" || stroke.name === "backspace") {
    const scope = editableScope(row);
    if (!scope || row?.kind !== "rule") {
      return { kind: "update", view: { ...view, message: { text: t("manage.perm.readOnly"), tone: "error" } } };
    }
    return {
      kind: "update",
      view: {
        ...view,
        confirmDelete: true,
        message: { text: `${t("manage.perm.confirmDelete")} ${describeRule(row.rule)} (${row.path})`, tone: "error" },
      },
    };
  }
  return { kind: "ignore" };
}
