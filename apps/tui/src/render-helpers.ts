/**
 * Pure formatting helpers for the polished transcript UI: friendly tool
 * titles ("Read(src/app.ts)"), one-line result summaries for the ⎿ row,
 * durations, the turn summary line, tips, footer key hints, markdown table
 * layout, and diff line numbering. No Ink imports — everything here is
 * unit-testable plain data in / strings out.
 */
import type { DiffLine } from "./model.js";
import { kfmt } from "./format.js";
import { STRINGS, TIP_COUNT, t } from "./strings.js";

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

/**
 * Terminal column width of a single code point (East Asian Width approximation).
 * 0 for combining/zero-width marks, 2 for wide CJK / fullwidth / most emoji,
 * 1 otherwise. Good enough to align tables without pulling in `string-width`.
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    // BMP emoji that render as 2 columns (✅ ❌ ⭐ ⚠ ▶ … — common in LLM tables).
    (cp >= 0x231a && cp <= 0x231b) || // watch, hourglass
    (cp >= 0x23e9 && cp <= 0x23f3) || // media buttons, hourglass
    (cp >= 0x23f8 && cp <= 0x23fa) || // pause/record buttons
    cp === 0x24c2 || // circled M
    (cp >= 0x25aa && cp <= 0x25ab) || // small squares
    cp === 0x25b6 ||
    cp === 0x25c0 || // play/reverse
    (cp >= 0x25fb && cp <= 0x25fe) || // squares
    // Default-emoji-presentation codepoints (Emoji_Presentation=Yes) that render
    // as 2 columns; deliberately NOT the whole 0x2600–0x27bf block, most of which
    // is text/ambiguous width (1 column) absent a variation selector.
    (cp >= 0x2614 && cp <= 0x2615) || // umbrella, hot beverage
    (cp >= 0x2648 && cp <= 0x2653) || // zodiac
    cp === 0x267f || // wheelchair
    cp === 0x2693 || // anchor
    cp === 0x26a1 || // high voltage
    (cp >= 0x26aa && cp <= 0x26ab) || // circles
    (cp >= 0x26bd && cp <= 0x26be) || // soccer, baseball
    (cp >= 0x26c4 && cp <= 0x26c5) || // snowman, sun behind cloud
    cp === 0x26ce || // ophiuchus
    cp === 0x26d4 || // no entry
    cp === 0x26ea || // church
    (cp >= 0x26f2 && cp <= 0x26f3) || // fountain, golf
    cp === 0x26f5 || // sailboat
    cp === 0x26fa || // tent
    cp === 0x26fd || // fuel pump
    cp === 0x2705 || // white heavy check mark ✅
    (cp >= 0x270a && cp <= 0x270b) || // raised fist/hand
    cp === 0x2728 || // sparkles
    (cp >= 0x274c && cp <= 0x274c) || // cross mark ❌
    cp === 0x274e || // negative squared cross mark
    (cp >= 0x2753 && cp <= 0x2755) || // question/exclamation marks
    cp === 0x2757 || // heavy exclamation
    (cp >= 0x2795 && cp <= 0x2797) || // heavy plus/minus/division
    cp === 0x27b0 || // curly loop
    cp === 0x27bf || // double curly loop
    (cp >= 0x2934 && cp <= 0x2935) || // curved arrows
    (cp >= 0x2b05 && cp <= 0x2b07) || // arrows
    (cp >= 0x2b1b && cp <= 0x2b1c) || // squares
    cp === 0x2b50 || // star ⭐
    cp === 0x2b55 || // heavy large circle
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Terminal column width of a whole string (sum of per-code-point widths). */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Leading (or trailing) run of `s` fitting within `maxW` columns. */
function sliceToWidth(s: string, maxW: number, fromStart: boolean): string {
  const chars = [...s];
  if (!fromStart) chars.reverse();
  const out: string[] = [];
  let w = 0;
  for (const ch of chars) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > maxW) break;
    w += cw;
    out.push(ch);
  }
  if (!fromStart) out.reverse();
  return out.join("");
}

/** Middle-truncate by terminal columns (wide-char aware), cut marked with "…". */
function truncateToWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  if (max <= 1) return "…";
  const headW = Math.ceil((max - 1) / 2);
  const tailW = max - 1 - headW;
  const head = sliceToWidth(s, headW, true);
  const tail = tailW > 0 ? sliceToWidth(s, tailW, false) : "";
  return `${head}…${tail}`;
}

/** Right-pad `s` with spaces until it occupies `w` terminal columns. */
function padEndToWidth(s: string, w: number): string {
  const pad = w - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
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
    case "glob":
      return t("Glob", strField(a, "pattern"));
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

/**
 * One-line tips rotated under the welcome banner. The canonical (English)
 * values live in strings.ts under "tips.N"; this array exposes the en list
 * for callers/tests that need the full set. pickTip resolves through t() so
 * the active locale applies.
 */
export const TIPS: readonly string[] = Array.from(
  { length: TIP_COUNT },
  (_, i) => STRINGS.en[`tips.${i}`] as string,
);

/** Pick a tip; a seed makes the choice deterministic (tests, per-session). */
export function pickTip(seed?: number): string {
  const i =
    seed === undefined
      ? Math.floor(Math.random() * TIPS.length)
      : Math.abs(Math.trunc(seed)) % TIPS.length;
  return t(`tips.${i}`);
}

/** Context-sensitive footer hints below the composer. */
export function keyHints(mode: "idle" | "running" | "permission"): string {
  return t(`hints.${mode}`);
}

/** TERM_PROGRAM values known to render OSC 8 hyperlinks. */
const OSC8_TERMS: readonly string[] = ["iTerm.app", "WezTerm", "kitty", "vscode"];

/**
 * Whether the current terminal is known to support OSC 8 hyperlinks.
 * Gated on TERM_PROGRAM (iTerm.app / WezTerm / kitty / vscode) or an
 * explicit FORCE_HYPERLINK opt-in (any non-empty, non-"0" value).
 */
export function supportsHyperlinks(env: Record<string, string | undefined> = process.env): boolean {
  const force = env.FORCE_HYPERLINK;
  if (force !== undefined && force !== "") return force !== "0";
  const term = env.TERM_PROGRAM;
  return term !== undefined && OSC8_TERMS.includes(term);
}

/**
 * Wrap `text` in an OSC 8 hyperlink to `url` when the terminal supports it;
 * otherwise return `text` unchanged (callers then fall back to plain
 * underline+url rendering). Uses the BEL terminator () like the JS
 * terminal-link ecosystem, so Ink's string-width sees zero-width escapes and
 * layout stays correct. Unsupporting terminals ignore the escapes entirely.
 */
export function osc8Link(
  text: string,
  url: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!supportsHyperlinks(env)) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
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
    // Terminal columns, not code units: a CJK/fullwidth cell is 2 wide, so
    // .length would under-measure and misalign every following column.
    widths.push(Math.max(1, ...body.map((r) => displayWidth(r[c] ?? ""))));
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
      .map((w, c) => padEndToWidth(truncateToWidth(cells[c] ?? "", w), w))
      .join(TABLE_GAP)
      .trimEnd();

  const out: string[] = [renderRow(body[0] as string[])];
  out.push("─".repeat(Math.min(total(), TABLE_WIDTH_CAP)));
  for (const row of body.slice(1)) out.push(renderRow(row));
  return out;
}
