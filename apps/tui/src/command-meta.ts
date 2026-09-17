/**
 * Grouped help data for the /help overlay: flattens the command registry
 * into header + command rows in COMMAND_GROUPS order. The component handles
 * padding/alignment; labels here are raw "/name args" strings.
 */

import { COMMANDS, COMMAND_GROUPS, commandGroupLabel, commandSummary, type CommandSpec } from "./commands.js";
import { ACTION_IDS, type Binding, formatBinding } from "./keymap.js";
import { translate } from "./strings.js";

export type HelpRow =
  | { kind: "header"; text: string }
  | { kind: "command"; name: string; label: string; summary: string };

/**
 * Rows for the grouped help overlay, in COMMAND_GROUPS order. Header rows
 * render as "── Session ──"; groups with no commands are skipped. Within a
 * group, commands keep registry order.
 */
export function helpRows(specs: readonly CommandSpec[] = COMMANDS): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const [group, title] of COMMAND_GROUPS) {
    const members = specs.filter((s) => s.group === group);
    if (members.length === 0) continue;
    rows.push({ kind: "header", text: `── ${commandGroupLabel(group, title)} ──` });
    for (const spec of members) {
      rows.push({
        kind: "command",
        name: spec.name,
        label: spec.args ? `/${spec.name} ${spec.args}` : `/${spec.name}`,
        summary: commandSummary(spec),
      });
    }
  }
  return rows;
}

/**
 * The keyboard section of /help, from the EFFECTIVE keymap (user overrides
 * included): one line per action that has a binding, in action order.
 */
export function shortcutLines(table: readonly Binding[]): string[] {
  const lines = [`── ${translate("keys.header", "Keyboard shortcuts")} ──`];
  for (const action of ACTION_IDS) {
    const keys = [...new Set(table.filter((b) => b.action === action).map(formatBinding))];
    if (keys.length === 0) continue;
    lines.push(`  ${keys.join(" / ").padEnd(26)} ${translate(`action.${action}`, action)}`);
  }
  return lines;
}

/** Indices of command rows (the overlay skips headers when navigating). */
export function selectableIndices(rows: readonly HelpRow[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if ((rows[i] as HelpRow).kind === "command") indices.push(i);
  }
  return indices;
}
