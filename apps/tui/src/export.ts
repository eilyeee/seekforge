/**
 * Transcript → markdown export (/export). Pure serialization of ChatItems so
 * a session can be shared or archived; the app writes the file.
 */

import type { ChatItem } from "./model.js";

export function transcriptToMarkdown(items: readonly ChatItem[], opts?: { title?: string }): string {
  const out: string[] = [`# ${opts?.title ?? "SeekForge session"}`, ""];
  for (const item of items) {
    switch (item.kind) {
      case "user":
        out.push(`## ❯ ${item.text}`, "");
        break;
      case "assistant":
        out.push(item.text.trimEnd(), "");
        break;
      case "step":
        out.push(item.agentId ? `> ↳ [${item.agentId}] ${item.title}` : `> ${item.title}`, "");
        break;
      case "tool": {
        const mark = item.status === "ok" ? "✓" : item.status === "error" ? "✗" : "…";
        const err = item.error ? ` — ${item.error.code}: ${item.error.message}` : "";
        out.push(`- ${mark} \`${item.toolName}\`${err}`);
        break;
      }
      case "plan":
        out.push("**Plan**", "");
        for (const p of item.items) {
          const box = p.status === "done" ? "[x]" : "[ ]";
          out.push(`- ${box} ${p.step}${p.status === "in_progress" ? " ←" : ""}`);
        }
        out.push("");
        break;
      case "file":
        out.push(`- ● changed \`${item.path}\``);
        break;
      case "diff":
        out.push(`**Diff: ${item.path}**`, "", "```diff");
        for (const l of item.lines) out.push(l.text);
        out.push("```", "");
        break;
      case "shell":
        out.push(`**$ ${item.command}** (exit ${item.exitCode})`, "", "```");
        out.push(item.output.trimEnd());
        out.push("```", "");
        break;
      case "notice":
        out.push(`> ${item.text}`);
        break;
      case "report":
        out.push("---", "", "**Report**", "", item.report.summary.trimEnd(), "");
        if (item.report.changedFiles.length > 0) {
          out.push("Changed files:");
          for (const f of item.report.changedFiles) out.push(`- \`${f}\``);
          out.push("");
        }
        if (item.report.verification) out.push(`Verification: ${item.report.verification}`, "");
        break;
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Default export path: .seekforge/exports/tui-<timestamp>.md */
export function defaultExportPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `.seekforge/exports/tui-${stamp}.md`;
}

/** Audit export path: .seekforge/exports/audit-<sessionId>-<timestamp>.md */
export function auditExportPath(sessionId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `.seekforge/exports/audit-${sessionId}-${stamp}.md`;
}
