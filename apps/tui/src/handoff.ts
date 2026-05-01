/**
 * Session handoff builders (/handoff). Distills a session's ChatItems into a
 * compact markdown brief a FRESH session (or another person) can pick up from:
 * what was asked, what was touched, what was run, and what is still open.
 *
 * Unlike export.ts (a full transcript), a handoff is deliberately lossy —
 * each section is deduped and capped so the brief stays a one-screen read
 * instead of re-importing the context that forced the handoff.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatItem } from "./model.js";

/** Per-section entry caps; oldest entries beyond the cap are summarized away. */
export const HANDOFF_CAPS = { tasks: 10, files: 30, commands: 15 } as const;

export type BuildHandoffInput = {
  items: readonly ChatItem[];
  sessionId?: string;
  model: string;
  costUsd: number;
};

export function buildHandoff(input: BuildHandoffInput): string {
  const { items } = input;

  const tasks = items.filter((i) => i.kind === "user").map((i) => i.text.trim()).filter(Boolean);

  // Files touched: file + diff items, deduped in first-seen order.
  const files: string[] = [];
  for (const i of items) {
    if ((i.kind === "file" || i.kind === "diff") && !files.includes(i.path)) files.push(i.path);
  }

  // Commands run: run_command tool items, deduped in first-seen order.
  const commands: string[] = [];
  for (const i of items) {
    if (i.kind !== "tool" || i.toolName !== "run_command") continue;
    const cmd = (i.args as { command?: unknown } | null)?.command;
    if (typeof cmd === "string" && cmd.trim() !== "" && !commands.includes(cmd)) commands.push(cmd);
  }

  const out: string[] = ["# Session handoff", ""];
  out.push(`- Model: ${input.model}`);
  if (input.sessionId) out.push(`- Session: ${input.sessionId}`);
  out.push(`- Cost: $${input.costUsd.toFixed(4)}`, "");

  out.push("## Tasks", "");
  pushCapped(out, tasks, HANDOFF_CAPS.tasks, "(no user messages this session)");

  out.push("## Files touched", "");
  pushCapped(out, files.map((f) => `\`${f}\``), HANDOFF_CAPS.files, "(none)");

  out.push("## Commands run", "");
  pushCapped(out, commands.map((c) => `\`${c}\``), HANDOFF_CAPS.commands, "(none)");

  out.push("## Open questions", "");
  const open = trailingBullets(lastAssistantText(items));
  if (open.length > 0) for (const q of open) out.push(`- ${q}`);
  else out.push("- (none — review the last assistant message for context)");

  return `${out.join("\n").trimEnd()}\n`;
}

function pushCapped(out: string[], entries: string[], cap: number, empty: string): void {
  if (entries.length === 0) {
    out.push(`- ${empty}`, "");
    return;
  }
  // Keep the MOST RECENT entries — they matter most for picking work back up.
  const omitted = Math.max(0, entries.length - cap);
  if (omitted > 0) out.push(`- … ${omitted} earlier omitted`);
  for (const e of entries.slice(omitted)) out.push(`- ${e}`);
  out.push("");
}

function lastAssistantText(items: readonly ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === "assistant") return it.text;
  }
  return "";
}

/** Trailing run of bullet lines ("- x" / "* x") at the very end of the text. */
function trailingBullets(text: string): string[] {
  const lines = text.trimEnd().split("\n");
  const bullets: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[-*]\s+(.+)$/.exec(lines[i]!);
    if (!m) break;
    bullets.unshift(m[1]!.trim());
  }
  // A bullet list needs a non-bullet line above it (else it is the whole
  // message, e.g. a plain list answer, not an "open questions" tail).
  return bullets.length > 0 && bullets.length < lines.length ? bullets : [];
}

/** Default handoff path: .seekforge/handoffs/handoff-<timestamp>.md */
export function handoffPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `.seekforge/handoffs/handoff-${stamp}.md`;
}

/** Absolute paths of saved handoffs, newest first (stamped names sort). */
export function listHandoffs(workspace: string): string[] {
  const dir = join(workspace, ".seekforge", "handoffs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("handoff-") && n.endsWith(".md"))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((n) => join(dir, n));
}

/** First 10 lines of the newest handoff, or null when none exist. */
export function latestHandoff(workspace: string): string | null {
  const newest = listHandoffs(workspace)[0];
  if (!newest) return null;
  try {
    return readFileSync(newest, "utf8").split("\n").slice(0, 10).join("\n");
  } catch {
    return null;
  }
}
