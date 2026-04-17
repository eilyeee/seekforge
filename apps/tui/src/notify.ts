/**
 * OS notifications with a terminal-bell fallback. Used for permission prompts
 * and run completion; always fire-and-forget so the UI never blocks.
 */
import { spawn } from "node:child_process";

/** What the notification is about; callers pick title/body per kind. */
export type NotifyKind = "permission" | "done";

/** Escapes backslashes and double quotes for an AppleScript string literal. */
function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Builds the platform notification command, or null when the platform has no
 * known notifier (the bell still rings in that case).
 *  - darwin: osascript -e 'display notification "<body>" with title "<title>"'
 *  - linux:  notify-send <title> <body>
 */
export function buildNotifyCommand(
  platform: string,
  title: string,
  body: string,
): { bin: string; args: string[] } | null {
  if (platform === "darwin") {
    return {
      bin: "osascript",
      args: ["-e", `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`],
    };
  }
  if (platform === "linux") {
    return { bin: "notify-send", args: [title, body] };
  }
  return null;
}

/**
 * Shows an OS notification (when the platform supports one) and rings the
 * terminal bell unless opts.bell === false. Fire-and-forget: the notifier is
 * spawned detached with ignored stdio and never awaited. Never throws.
 */
export function notify(title: string, body: string, opts?: { bell?: boolean }): void {
  try {
    const cmd = buildNotifyCommand(process.platform, title, body);
    if (cmd) {
      const child = spawn(cmd.bin, cmd.args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    // best effort — fall through to the bell
  }
  if (opts?.bell !== false) {
    try {
      process.stdout.write("\x07");
    } catch {
      // a closed stdout must not crash the app
    }
  }
}
