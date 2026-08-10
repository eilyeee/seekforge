/**
 * Pure argument parsing + transcript formatting for the `/graph-*` slash
 * commands, mirroring what loop-format.ts does for `/loop`.
 *
 * Deliberately NOT here: whether a control command or a signal may act on a
 * Graph right now. `checkGraphControlTarget` / `checkGraphSignalTarget` in
 * @seekforge/core own that rule for every surface, and app.tsx calls them
 * directly — a second copy of the state machine in the TUI is exactly the drift
 * those helpers exist to prevent. Graph-id shape is likewise core's
 * `isValidLoopDagId`, not a local regex. No fs, no Ink, no i18n.
 */

import { isValidLoopDagId, type EngineeringGraphState } from "@seekforge/core";
import { clipLine, formatCostUsd } from "@seekforge/shared/format";

/** Persisted-Graph rows shown per `/graph-list` and in the argument picker. */
const LIST_MAX = 20;
/** Node result lines shown per `/graph-show`. */
const SHOW_NODES_MAX = 20;

/**
 * `<graph-id>` on its own. Returns null for a missing, extra-word or malformed
 * id so the caller can print one usage line.
 */
export function parseGraphId(arg: string | undefined): string | null {
  const words = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length === 1 && isValidLoopDagId(words[0] as string) ? (words[0] as string) : null;
}

/**
 * `<graph-id> <free text…>` — everything after the id is one operand (the
 * steer guidance). Internal spacing of the operand is preserved as the
 * composer produced it; leading/trailing space is dropped.
 */
export function parseGraphRest(arg: string | undefined): { graphId: string; rest: string } | null {
  const match = /^(\S+)\s+([\s\S]+)$/.exec((arg ?? "").trim());
  if (!match) return null;
  const graphId = match[1] as string;
  const rest = (match[2] as string).trim();
  return isValidLoopDagId(graphId) && rest !== "" ? { graphId, rest } : null;
}

/**
 * `<graph-id> <name>` — exactly two words. The signal NAME is not validated
 * here: `checkGraphSignalTarget` owns "is this a declared wait signal", and a
 * local shape check would only produce a second, weaker error message.
 */
export function parseGraphSignal(arg: string | undefined): { graphId: string; name: string } | null {
  const words = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length !== 2) return null;
  const graphId = words[0] as string;
  return isValidLoopDagId(graphId) ? { graphId, name: words[1] as string } : null;
}

/** "paused (approval)" — the pause reason is the actionable half of `paused`. */
function statusLabel(state: EngineeringGraphState): string {
  return state.status === "paused" && state.pauseReason ? `${state.status} (${state.pauseReason})` : state.status;
}

/**
 * One line per persisted Graph, capped to LIST_MAX:
 * `id · status · settled/total nodes · priority N · updatedAt`. Ordering is
 * `listEngineeringGraphStates`' (newest updated first) — re-sorting here would
 * be a second comparator for the same list.
 */
export function formatGraphListLines(states: readonly EngineeringGraphState[]): string[] {
  if (states.length === 0) return ["no persisted Graphs"];
  const lines = states
    .slice(0, LIST_MAX)
    .map(
      (state) =>
        `${state.graphId} · ${statusLabel(state)} · ${state.results.length}/${state.definition.nodes.length} nodes · priority ${state.priority} · ${state.updatedAt}`,
    );
  const hidden = states.length - lines.length;
  if (hidden > 0) lines.push(`… ${hidden} more Graph${hidden === 1 ? "" : "s"} (/graph-show <graph-id>)`);
  return lines;
}

/** Marker for a settled node, matching the loop transcript's ✓/✗ vocabulary. */
function nodeMarker(status: EngineeringGraphState["results"][number]["status"]): string {
  return status === "passed" ? "✓" : status === "failed" ? "✗" : "·";
}

/**
 * Header + totals + per-node result lines for one persisted Graph. Node lines
 * are capped; the overflow is summarized rather than dropped silently.
 */
export function formatGraphShowLines(state: EngineeringGraphState): string[] {
  const lines = [
    `${state.graphId} · ${statusLabel(state)}`,
    `  nodes ${state.results.length}/${state.definition.nodes.length} · ${formatCostUsd(state.spentCost)} · ${state.spentTokens} tokens · priority ${state.priority}`,
    `  updated ${state.updatedAt}`,
  ];
  for (const result of state.results.slice(0, SHOW_NODES_MAX)) {
    const detail = result.error ? ` — ${clipLine(result.error, 80)}` : "";
    lines.push(`  ${nodeMarker(result.status)} ${result.id} · ${result.status}${detail}`);
  }
  const hidden = state.results.length - SHOW_NODES_MAX;
  if (hidden > 0) lines.push(`  … ${hidden} more node${hidden === 1 ? "" : "s"}`);
  return lines;
}
