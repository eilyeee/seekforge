/**
 * /skills and /plugins: enable or disable one entry. The enable state has one
 * owner each in core — `setSkillEnabled` (skill.json / override markers) and
 * `setPluginEnabled` (the plugin approval store) — and the CLI and server call
 * the same functions.
 *
 * Enabling a plugin approves its current digest, which lets its hooks and MCP
 * servers start, so it asks for confirmation and names what the plugin
 * contributes. Repository plugins cannot be enabled at all: they are reviewed
 * and installed first (`seekforge plugin install`).
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SKILLS, type PluginRecord, resolveSkillsStoreRoot, SKILL_ID_RE, seekforgeHome } from "@seekforge/core";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "../bounded-file.js";
import type { KeyStroke } from "../keymap.js";
import type { SkillRow } from "../skills-surface.js";
import { t } from "../strings.js";
import { listDelta, type ManageMessage, moveIndex } from "./common.js";

export type ToggleRow = {
  id: string;
  scope: string;
  enabled: boolean;
  description?: string;
  /** Plugin-only: approval status, contributed capabilities, load error. */
  status?: PluginRecord["status"];
  capabilities?: string[];
  error?: string;
};

export type ToggleKind = "skills" | "plugins";

export type ToggleView = {
  kind: ToggleKind;
  rows: ToggleRow[];
  index: number;
  /** A plugin id waiting for `y` to be enabled. */
  confirmEnable?: string;
  message?: ManageMessage;
};

export type ToggleEffect =
  | { kind: "set-skill"; id: string; enabled: boolean; scope: string }
  | { kind: "set-plugin"; id: string; enabled: boolean };

export type ToggleOutcome =
  | { kind: "update"; view: ToggleView }
  | { kind: "effect"; view: ToggleView; effect: ToggleEffect }
  | { kind: "close" }
  | { kind: "ignore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Skills switched off in a layer's own directory. The loader drops disabled
 * skills entirely, so without this a skill disabled here could never be
 * switched back on from here.
 */
export function disabledStoreSkills(workspace: string, home: string = seekforgeHome()): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const [scope, base] of [
    ["project", workspace],
    ["global", home],
  ] as const) {
    let root: string | undefined;
    try {
      root = resolveSkillsStoreRoot(base, false);
    } catch {
      continue;
    }
    if (!root) continue;
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const id of names) {
      if (!SKILL_ID_RE.test(id)) continue;
      try {
        const md = lstatSync(join(root, id, "SKILL.md"), { throwIfNoEntry: false });
        if (!md?.isFile()) continue; // a bare marker disables a builtin, listed with it
        const json: unknown = JSON.parse(readTextFileBounded(join(root, id, "skill.json"), MAX_CONFIG_FILE_BYTES));
        if (!isRecord(json) || json["enabled"] !== false) continue;
        rows.push({
          id,
          scope,
          disabled: true,
          ...(typeof json["description"] === "string" ? { description: json["description"] } : {}),
        });
      } catch {
        // unreadable or malformed: /skills already reports load diagnostics
      }
    }
  }
  return rows;
}

export function skillToggleRows(loaded: readonly SkillRow[], disabled: readonly SkillRow[]): ToggleRow[] {
  const seen = new Set(loaded.map((row) => row.id));
  return [...loaded, ...disabled.filter((row) => !seen.has(row.id))].map((row) => ({
    id: row.id,
    scope: row.scope ?? "project",
    enabled: row.disabled !== true,
    ...(row.description ? { description: row.description } : {}),
  }));
}

export function pluginToggleRows(plugins: readonly PluginRecord[]): ToggleRow[] {
  return plugins.map((plugin) => {
    const contributes = plugin.manifest?.contributes;
    const capabilities = [
      ...(contributes?.skillRoots?.length ? ["skills"] : []),
      ...(contributes?.agentRoots?.length ? ["agents"] : []),
      ...(Object.keys(contributes?.mcpServers ?? {}).length ? ["mcp"] : []),
      ...(Object.keys(contributes?.hooks ?? {}).length ? ["hooks"] : []),
      ...(Object.keys(contributes?.graphHandlers ?? {}).length ? ["graph-handlers"] : []),
      ...(Object.keys(contributes?.graphExecutors ?? {}).length ? ["graph-executors"] : []),
    ];
    return {
      id: plugin.id,
      scope: plugin.scope,
      enabled: plugin.status === "enabled",
      status: plugin.status,
      capabilities,
      ...(plugin.manifest?.description ? { description: plugin.manifest.description } : {}),
      ...(plugin.error ? { error: plugin.error } : {}),
    };
  });
}

export function toggleRowLine(kind: ToggleKind, row: ToggleRow): string {
  const mark = row.enabled ? "[x]" : "[ ]";
  const status = kind === "plugins" && row.status ? `  ${row.status}` : "";
  const flat = (row.error ?? row.description ?? "").replace(/\s+/g, " ").trim();
  const text = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  const caps = row.capabilities && row.capabilities.length > 0 ? `  {${row.capabilities.join(", ")}}` : "";
  return `${mark} ${row.id}  (${row.scope})${status}${caps}  ${text}`.trimEnd();
}

export function isBuiltinSkill(id: string): boolean {
  return BUILTIN_SKILLS.some((skill) => skill.id === id);
}

/**
 * The (layer, enabled) calls that switch one skill: a builtin is disabled with
 * a project marker and re-enabled by clearing markers in both layers (the
 * listing cannot tell which layer disabled it); any other skill is switched in
 * the layer it lives in.
 */
export function skillToggleCalls(id: string, scope: string, enabled: boolean): Array<{ global: boolean }> {
  if (scope === "builtin" && isBuiltinSkill(id)) {
    return enabled ? [{ global: false }, { global: true }] : [{ global: false }];
  }
  return [{ global: scope === "global" }];
}

export function toggleKey(view: ToggleView, input: string, stroke: KeyStroke): ToggleOutcome {
  const delta = listDelta(stroke);
  if (delta !== undefined) {
    const { confirmEnable: _dropped, ...rest } = view;
    return { kind: "update", view: { ...rest, index: moveIndex(view.index, delta, view.rows.length) } };
  }
  if (stroke.name === "escape") return { kind: "close" };
  if (view.confirmEnable) {
    const { confirmEnable: id, ...rest } = view;
    if (input === "y") return { kind: "effect", view: rest, effect: { kind: "set-plugin", id, enabled: true } };
    return { kind: "update", view: { ...rest, message: { text: t("manage.cancelled"), tone: "dim" } } };
  }
  const row = view.rows[view.index];
  const toggle = input === " " || input === "e" || stroke.name === "return";
  if (!row || !toggle || stroke.ctrl || stroke.meta) return { kind: "ignore" };

  if (view.kind === "skills") {
    return { kind: "effect", view, effect: { kind: "set-skill", id: row.id, enabled: !row.enabled, scope: row.scope } };
  }

  if (row.status === "invalid") {
    return { kind: "update", view: { ...view, message: { text: t("manage.plugins.invalid"), tone: "error" } } };
  }
  if (row.scope === "project") {
    return { kind: "update", view: { ...view, message: { text: t("manage.plugins.project"), tone: "error" } } };
  }
  if (row.enabled) return { kind: "effect", view, effect: { kind: "set-plugin", id: row.id, enabled: false } };
  const contributes = row.capabilities && row.capabilities.length > 0 ? row.capabilities.join(", ") : "nothing";
  return {
    kind: "update",
    view: {
      ...view,
      confirmEnable: row.id,
      message: { text: `${t("manage.plugins.confirmEnable")} ${contributes}`, tone: "error" },
    },
  };
}
