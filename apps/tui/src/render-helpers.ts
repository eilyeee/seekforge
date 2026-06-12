/**
 * Pure formatting helpers for the polished transcript UI: friendly tool
 * titles ("Read(src/app.ts)"), one-line result summaries for the ⎿ row,
 * durations, the turn summary line, tips, footer key hints, markdown table
 * layout, and diff line numbering. No Ink imports — everything here is
 * unit-testable plain data in / strings out.
 */
import type { DiffLine } from "./model.js";
import { kfmt } from "./format.js";

/** Max characters for a tool title's detail part. */
const DETAIL_CAP = 80;
/** Max characters for an error summary on the ⎿ line. */
const ERROR_CAP = 100;

/** Middle-truncate `s` to at most `max` chars, marking the cut with "…". */
function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

/** First `max` chars of `s` (single-line), with a trailing "…" when cut. */
function headTruncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

function strField(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string") return v;
  }
  return "";
}

/** Compact JSON of `args` capped at `max` chars ("" when not serializable). */
function compactJson(args: unknown, max: number): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "";
  } catch {
    text = String(args);
  }
  if (text === "{}" || text === "null") text = "";
  return middleTruncate(text, max);
}

/** First few argument values of an object, joined: `"a", "b"`. */
function firstArgValues(args: unknown, max: number): string {
  const rec = asRecord(args);
  const vals: string[] = [];
  for (const v of Object.values(rec)) {
    if (typeof v === "string") vals.push(v);
    else if (typeof v === "number" || typeof v === "boolean") vals.push(String(v));
    if (vals.length >= 3) break;
  }
  return middleTruncate(vals.join(", "), max);
}

/**
 * Claude Code-style friendly tool title: "Read(src/app.ts)",
 * "Bash(npm test)", "Search("foo", path: src)". Unknown tools fall back to
 * the raw name plus compact JSON args. The detail is capped at 80 chars
 * (middle-truncated).
 */
export function toolTitle(toolName: string, args: unknown): { verb: string; detail: string } {
  const a = asRecord(args);
  const t = (verb: string, detail: string): { verb: string; detail: string } => ({
    verb,
    detail: middleTruncate(detail.replace(/\s+/g, " "), DETAIL_CAP),
  });

  switch (toolName) {
    case "read_file":
      return t("Read", strField(a, "path"));
    case "write_file":
      return t("Write", strField(a, "path"));
    case "apply_patch":
      return t("Update", strField(a, "path"));
    case "list_files":
      return t("List", strField(a, "path") || ".");
    case "search_text": {
      const query = strField(a, "pattern", "query");
      const path = strField(a, "path");
      return t("Search", path ? `"${query}", path: ${path}` : `"${query}"`);
    }
    case "run_command": {
      const cmd = strField(a, "command");
      return t("Bash", a["background"] === true ? `${cmd} + background` : cmd);
    }
    case "git_diff":
      return t("Diff", a["staged"] === true ? "staged" : "");
    case "git_status":
      return t("GitStatus", "");
    case "update_plan":
      return t("Plan", "");
    case "web_search":
      return t("WebSearch", strField(a, "query"));
    case "web_fetch":
      return t("WebFetch", strField(a, "url"));
    case "task_output":
      return t("TaskOutput", strField(a, "taskId", "id"));
    case "task_kill":
      return t("TaskKill", strField(a, "taskId", "id"));
    case "dispatch_agent": {
      const agentId = strField(a, "agentId");
      const task = headTruncate(strField(a, "task"), 60);
      return t("Agent", agentId ? `${agentId}: ${task}` : task);
    }
    case "agent_result":
      return t("AgentResult", strField(a, "dispatchId", "id"));
    case "agent_send":
      return t("AgentSend", strField(a, "dispatchId", "id"));
    case "ask_user":
      return t("Question", headTruncate(strField(a, "question"), 60));
    case "memory_read":
      return t("MemoryRead", strField(a, "path"));
    case "memory_write":
      return t("MemoryWrite", strField(a, "path"));
    default: {
      const mcp = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
      if (mcp) return t(`${mcp[1]}:${mcp[2]}`, firstArgValues(args, DETAIL_CAP));
      return t(toolName, compactJson(args, DETAIL_CAP));
    }
  }
}

/** JSON.parse that never throws (truncated previews etc. → undefined). */
function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One-line result summary for the ⎿ line: "120 lines", "2 matches",
 * "exit 0 in 1.2s", "12 entries", "ok", or the error "code: message".
 * `resultPreview` is JSON-ish text and may be truncated — parsing is
 * defensive and any doubt yields null (the row then shows no ⎿ line).
 */
export function toolResultSummary(
  toolName: string,
  ok: boolean,
  resultPreview?: string,
  error?: { code: string; message: string },
): string | null {
  if (!ok) {
    if (!error) return null;
    return middleTruncate(`${error.code}: ${error.message}`.replace(/\s+/g, " "), ERROR_CAP);
  }

  switch (toolName) {
    case "write_file":
    case "apply_patch":
      return "ok";
    default:
      break;
  }

  if (!resultPreview) return null;
  const data = safeParse(resultPreview);
  if (!data) return null;

  switch (toolName) {
    case "read_file": {
      if (typeof data["totalLines"] === "number") return `${data["totalLines"]} lines`;
      const content = data["content"];
      if (typeof content !== "string") return null;
      return `${content.split("\n").length} lines`;
    }
    case "run_command": {
      const exit = data["exitCode"];
      if (typeof exit !== "number") {
        // background launch returns { taskId } instead of an exit code
        return typeof data["taskId"] === "string" ? `task ${data["taskId"]}` : null;
      }
      const dur = data["durationMs"];
      return typeof dur === "number" ? `exit ${exit} in ${formatDuration(dur)}` : `exit ${exit}`;
    }
    case "search_text": {
      const count =
        typeof data["count"] === "number"
          ? data["count"]
          : Array.isArray(data["matches"])
            ? data["matches"].length
            : undefined;
      if (count === undefined) return null;
      return count === 1 ? "1 match" : `${count} matches`;
    }
    case "list_files": {
      const count =
        typeof data["count"] === "number"
          ? data["count"]
          : Array.isArray(data["entries"])
            ? data["entries"].length
            : undefined;
      if (count === undefined) return null;
      return count === 1 ? "1 entry" : `${count} entries`;
    }
    case "dispatch_agent": {
      const summary = data["summary"];
      return typeof summary === "string" ? headTruncate(summary, 60) : null;
    }
    default:
      return null;
  }
}

/** "0.8s" under 10s, "12s" under a minute, "2m04s" beyond. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** End-of-turn footer: "✓ 34s · $0.0123 · 12.4K tok". */
export function turnSummaryLine(p: { durationMs: number; costUsd: number; totalTokens: number }): string {
  return `✓ ${formatDuration(p.durationMs)} · $${p.costUsd.toFixed(4)} · ${kfmt(p.totalTokens)} tok`;
}

/** One-line tips rotated under the welcome banner. */
export const TIPS: readonly string[] = [
  "Type @ to attach files to your message",
  "Press / to open the command palette",
  "Start a line with # to save a note to project memory",
  "Start a line with ! to run a shell command directly",
  "Ctrl+B detaches the current run to the background",
  "Ctrl+O toggles verbose output (full diffs and tool results)",
  "Press Esc twice to backtrack to an earlier turn",
  "Shift+Tab cycles approval modes (confirm / auto / plan)",
  "Ctrl+R searches your prompt history",
  "/vim enables vim keybindings in the composer",
  "Drop markdown files in .seekforge/commands/ to add custom commands",
  "Ctrl+V pastes an image from the clipboard",
];

/** Pick a tip; a seed makes the choice deterministic (tests, per-session). */
export function pickTip(seed?: number): string {
  const i =
    seed === undefined
      ? Math.floor(Math.random() * TIPS.length)
      : Math.abs(Math.trunc(seed)) % TIPS.length;
  return TIPS[i] as string;
}

/** Context-sensitive footer hints below the composer. */
export function keyHints(mode: "idle" | "running" | "permission"): string {
  switch (mode) {
    case "running":
      return "Esc interrupt · Ctrl+B background · ⏎ queue";
    case "permission":
      return "y allow · a allow session · n deny";
    default:
      return "⏎ send · / commands · @ files · Ctrl+R history";
  }
}

/** Count add/del lines of a diff for the "+N −M" header badge. */
export function diffStats(lines: ReadonlyArray<{ kind: string }>): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of lines) {
    if (line.kind === "add") adds += 1;
    else if (line.kind === "del") dels += 1;
  }
  return { adds, dels };
}

/** Hunk header: "@@ -a,b +c,d @@" (counts optional). */
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export type NumberedDiffLine = { line: DiffLine; old?: number; new?: number };

/**
 * Attach old/new line numbers to diff lines from their hunk headers. Hunk
 * rows and rows before the first hunk get no numbers; adds get only `new`,
 * dels only `old`, context both.
 */
export function numberDiffLines(lines: readonly DiffLine[]): NumberedDiffLine[] {
  let oldNext: number | undefined;
  let newNext: number | undefined;
  const out: NumberedDiffLine[] = [];
  for (const line of lines) {
    if (line.kind === "hunk") {
      const m = HUNK_RE.exec(line.text);
      if (m) {
        oldNext = Number(m[1]);
        newNext = Number(m[2]);
      }
      out.push({ line });
      continue;
    }
    if (line.kind === "add") {
      out.push({ line, ...(newNext !== undefined ? { new: newNext++ } : {}) });
    } else if (line.kind === "del") {
      out.push({ line, ...(oldNext !== undefined ? { old: oldNext++ } : {}) });
    } else {
      out.push({
        line,
        ...(oldNext !== undefined ? { old: oldNext++ } : {}),
        ...(newNext !== undefined ? { new: newNext++ } : {}),
      });
    }
  }
  return out;
}

/** Markdown table separator cell: ---, :---, ---:, :---:. */
const SEP_CELL_RE = /^:?-{3,}:?$/;
/** Max rendered table width in columns. */
const TABLE_WIDTH_CAP = 100;
/** Gap between table columns. */
const TABLE_GAP = "  ";

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((c) => c.trim());
}

/**
 * Lay out a markdown table (header, |---| separator, data rows) into
 * aligned text lines: [header, "─" rule, ...rows]. Columns are padded to the
 * widest cell, total width capped at 100 (over-wide cells middle-truncated).
 * Returns null when the input is not a well-formed table.
 */
export function layoutTable(rows: string[]): string[] | null {
  if (rows.length < 2) return null;
  const parsed: string[][] = [];
  for (const row of rows) {
    const cells = parseTableRow(row);
    if (!cells) return null;
    parsed.push(cells);
  }
  const sep = parsed[1] as string[];
  if (sep.length === 0 || !sep.every((c) => SEP_CELL_RE.test(c))) return null;

  const body = [parsed[0] as string[], ...parsed.slice(2)];
  const cols = Math.max(...body.map((r) => r.length));
  if (cols === 0) return null;
  const widths: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    widths.push(Math.max(1, ...body.map((r) => (r[c] ?? "").length)));
  }

  // Shrink the widest column until the total fits the cap.
  const total = (): number => widths.reduce((a, b) => a + b, 0) + TABLE_GAP.length * (cols - 1);
  while (total() > TABLE_WIDTH_CAP) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] as number) <= 4) break; // give up: degenerate many-column table
    widths[widest] = (widths[widest] as number) - 1;
  }

  const renderRow = (cells: string[]): string =>
    widths
      .map((w, c) => {
        const cell = middleTruncate(cells[c] ?? "", w);
        return cell.padEnd(w);
      })
      .join(TABLE_GAP)
      .trimEnd();

  const out: string[] = [renderRow(body[0] as string[])];
  out.push("─".repeat(Math.min(total(), TABLE_WIDTH_CAP)));
  for (const row of body.slice(1)) out.push(renderRow(row));
  return out;
}
