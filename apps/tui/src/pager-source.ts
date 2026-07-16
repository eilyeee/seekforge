/**
 * Transcript → pager lines (Ctrl+L full-screen pager, à la DeepSeek-TUI
 * pager.rs). Unlike the live transcript, every item is fully expanded — no
 * verbose gate, no row caps, no truncation — and the output is plain text
 * (no ANSI) so windowing is pure line arithmetic.
 */

import type { ChatItem } from "./model.js";
import type { Window } from "./viewport.js";

/** Pushes multi-line text as individual lines, optionally prefixed. */
function pushText(out: string[], text: string, prefix = ""): void {
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) out.push(prefix + line);
}

/** Full plain-text transcript: one ChatItem after another, blank-line separated. */
export function pagerLines(items: readonly ChatItem[]): string[] {
  const out: string[] = [];
  const blank = (): void => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };

  for (const item of items) {
    switch (item.kind) {
      case "user": {
        blank();
        const userLines = item.text.replace(/\r\n/g, "\n").split("\n");
        userLines.forEach((line, i) => {
          out.push((i === 0 ? "❯ " : "  ") + line);
        });
        break;
      }
      case "assistant":
        blank();
        pushText(out, item.text.trimEnd());
        break;
      case "thinking":
        blank();
        out.push("✳ thinking");
        pushText(out, item.text.trimEnd(), "  ");
        break;
      case "step":
        out.push(item.agentId ? `→ [${item.agentId}] ${item.title}` : `→ ${item.title}`);
        break;
      case "tool": {
        const mark = item.status === "ok" ? "✓" : item.status === "error" ? "✗" : "…";
        const err = item.error ? ` — ${item.error.code}: ${item.error.message}` : "";
        out.push(`${mark} ${item.toolName}${err}`);
        if (item.resultPreview) pushText(out, item.resultPreview.trimEnd(), "  ");
        if (item.outputTail) pushText(out, item.outputTail.trimEnd(), "  ");
        break;
      }
      case "plan":
        blank();
        out.push("Plan");
        for (const p of item.items) {
          const box = p.status === "done" ? "[x]" : "[ ]";
          out.push(`  ${box} ${p.step}${p.status === "in_progress" ? " ←" : ""}`);
        }
        break;
      case "file":
        out.push(`● changed ${item.path}`);
        break;
      case "diff":
        blank();
        out.push(`Diff: ${item.path}`);
        for (const l of item.lines) out.push(l.text); // text carries +/-/@@ markers
        break;
      case "shell":
        blank();
        out.push(`$ ${item.command} (exit ${item.exitCode})`);
        pushText(out, item.output.trimEnd(), "  ");
        break;
      case "notice":
        out.push(`· ${item.text}`);
        break;
      case "report":
        blank();
        out.push("── Report ──");
        pushText(out, item.report.summary.trimEnd());
        if (item.report.changedFiles.length > 0) {
          out.push("Changed files:");
          for (const f of item.report.changedFiles) out.push(`  ● ${f}`);
        }
        if (item.report.verification) out.push(`Verification: ${item.report.verification}`);
        break;
    }
  }
  // Drop a leading/trailing blank so the pager starts and ends on content.
  while (out[0] === "") out.shift();
  while (out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Top-anchored window over the pager lines: `offset` = lines scrolled down
 * from the top, clamped so the last page is always full when possible.
 * (Same Window shape as viewport.computeWindow, which is bottom-anchored.)
 */
export function pagerWindow(lines: readonly string[], offset: number, height: number): Window {
  const total = Math.max(0, Math.floor(lines.length));
  const size = Math.max(0, Math.floor(height));
  const maxOffset = Math.max(0, total - size);
  const start = Math.min(maxOffset, Math.max(0, Math.floor(offset)));
  const end = Math.min(total, start + size);
  return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}
