/**
 * What the loop learns about a run's effects outside its own messages: which
 * files a tool call changed, and which background commands have finished.
 */
import type { ToolResult } from "@seekforge/shared";
import type { BackgroundTaskExitNotice } from "../tools/index.js";

/** A path a tool call handed to the checkpoint sink. */
export type TouchedPath = { path: string; shell: boolean };

/** Write tools whose `meta.path` is the one file they change. */
const SINGLE_FILE_EDIT_TOOLS = new Set(["apply_patch", "write_file", "notebook_edit", "lsp_format"]);
/** LSP tools whose `data.files` lists every file the workspace edit wrote. */
const WORKSPACE_EDIT_TOOLS = new Set(["lsp_rename", "lsp_apply_code_action"]);

/**
 * Workspace-relative paths one tool call changed, in first-seen order.
 *
 * Every write tool checkpoints a file before touching it, so what a call
 * checkpointed is the general answer — but a checkpoint precedes the write, so
 * it only counts when the call succeeded. A shell checkpoint is taken AFTER the
 * command from what git saw change, so it counts even when the command failed.
 * The result shapes are read as well, for dispatchers that do not checkpoint.
 */
export function changedPathsOf(
  toolName: string,
  result: ToolResult,
  touched: readonly TouchedPath[],
): Array<{ path: string; viaShellOnly: boolean }> {
  // path -> whether every source that reported it was a shell comparison
  const paths = new Map<string, boolean>();
  const add = (path: string, shell: boolean): void => {
    paths.set(path, (paths.get(path) ?? true) && shell);
  };
  for (const entry of touched) {
    if (entry.shell || result.ok) add(entry.path, entry.shell);
  }
  if (result.ok && SINGLE_FILE_EDIT_TOOLS.has(toolName) && typeof result.meta?.path === "string") {
    const formatted = (result.data as { formatted?: unknown } | undefined)?.formatted;
    if (toolName !== "lsp_format" || formatted !== false) add(result.meta.path, false);
  }
  if (result.ok && WORKSPACE_EDIT_TOOLS.has(toolName)) {
    const files = (result.data as { files?: unknown } | undefined)?.files;
    for (const file of Array.isArray(files) ? files : []) {
      const path = (file as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path !== "") add(path, false);
    }
  }
  return [...paths].map(([path, viaShellOnly]) => ({ path, viaShellOnly }));
}

/**
 * The harness note telling the model a background command finished. It points
 * at task_output instead of quoting the output: the output is command data,
 * and a harness message is the one place data must not be mixed into.
 */
export function backgroundExitMessages(notices: readonly BackgroundTaskExitNotice[]): {
  model: string;
  user: string[];
} {
  const lines = notices.map((notice) => {
    const outcome =
      notice.status === "cancelled"
        ? "was killed"
        : notice.exitCode !== null
          ? `exited with code ${notice.exitCode}`
          : notice.error
            ? `failed to start (${notice.error.message})`
            : "was terminated by a signal";
    return { id: notice.id, command: notice.command, outcome };
  });
  return {
    model:
      "[harness] Background task update:\n" +
      lines
        .map(
          (line) =>
            `- ${line.id} ${line.outcome}: ${JSON.stringify(line.command)} — read its output with task_output (taskId "${line.id}").`,
        )
        .join("\n"),
    user: lines.map((line) => `Background task ${line.id} ${line.outcome}: ${line.command}`),
  };
}
