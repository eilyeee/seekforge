/**
 * /hooks: the hooks that will run, stage by stage, with each entry's matcher,
 * type and raw command. Read-only; `e` opens the user config, the only config
 * file whose hooks are honored (repository hooks are stripped on load).
 */

import { HOOK_STAGES, type HookStage } from "@seekforge/shared";
import type { KeyStroke } from "../keymap.js";
import { t } from "../strings.js";
import { listDelta, type ManageMessage, moveIndex } from "./common.js";

export type HookRow =
  | { kind: "stage"; stage: HookStage; count: number }
  | { kind: "entry"; stage: HookStage; source: "config" | "plugins"; matcher: string; type: string; command: string };

export type HooksView = { kind: "hooks"; rows: HookRow[]; index: number; message?: ManageMessage };

export type HooksOutcome =
  | { kind: "update"; view: HooksView }
  | { kind: "effect"; view: HooksView; effect: { kind: "edit-user-config" } }
  | { kind: "close" }
  | { kind: "ignore" };

type HookSource = Partial<Record<string, readonly unknown[] | undefined>> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every stage in execution-model order, each followed by its entries (config first, then plugins). */
export function hookRows(configHooks: HookSource, pluginHooks: HookSource): HookRow[] {
  const rows: HookRow[] = [];
  for (const stage of HOOK_STAGES) {
    const entries: HookRow[] = [];
    for (const [source, hooks] of [
      ["config", configHooks],
      ["plugins", pluginHooks],
    ] as const) {
      for (const entry of hooks?.[stage] ?? []) {
        if (!isRecord(entry) || typeof entry["command"] !== "string") continue;
        const matcher =
          typeof entry["match"] === "string"
            ? entry["match"]
            : typeof entry["pattern"] === "string"
              ? `/${entry["pattern"]}/`
              : "*";
        entries.push({
          kind: "entry",
          stage,
          source,
          matcher,
          type: typeof entry["type"] === "string" ? entry["type"] : "command",
          command: entry["command"],
        });
      }
    }
    rows.push({ kind: "stage", stage, count: entries.length }, ...entries);
  }
  return rows;
}

export function hookRowLine(row: HookRow): string {
  if (row.kind === "stage") return `── ${row.stage} (${row.count}) ──`;
  return `  ${row.matcher.padEnd(16)} ${row.type.padEnd(8)} ${row.command}${row.source === "plugins" ? "  [plugin]" : ""}`;
}

export function hooksKey(view: HooksView, input: string, stroke: KeyStroke): HooksOutcome {
  const delta = listDelta(stroke);
  if (delta !== undefined)
    return { kind: "update", view: { ...view, index: moveIndex(view.index, delta, view.rows.length) } };
  if (stroke.name === "escape" || input === "q") return { kind: "close" };
  if (input === "e" && !stroke.ctrl && !stroke.meta)
    return { kind: "effect", view, effect: { kind: "edit-user-config" } };
  return { kind: "ignore" };
}

export function hooksEmptyNote(rows: readonly HookRow[]): string | undefined {
  return rows.every((row) => row.kind === "stage") ? t("manage.hooks.none") : undefined;
}
