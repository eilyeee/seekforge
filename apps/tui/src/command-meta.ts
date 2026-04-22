/**
 * Grouped help data for the /help overlay: flattens the command registry
 * into header + command rows in COMMAND_GROUPS order. The component handles
 * padding/alignment; labels here are raw "/name args" strings.
 */

import { COMMANDS, COMMAND_GROUPS, type CommandSpec } from "./commands.js";

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
    rows.push({ kind: "header", text: `── ${title} ──` });
    for (const spec of members) {
      rows.push({
        kind: "command",
        name: spec.name,
        label: spec.args ? `/${spec.name} ${spec.args}` : `/${spec.name}`,
        summary: spec.summary,
      });
    }
  }
  return rows;
}

/** Indices of command rows (the overlay skips headers when navigating). */
export function selectableIndices(rows: readonly HelpRow[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if ((rows[i] as HelpRow).kind === "command") indices.push(i);
  }
  return indices;
}
