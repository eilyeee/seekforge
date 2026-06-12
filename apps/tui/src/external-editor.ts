/**
 * $EDITOR round-trip for long prompts: write the draft to a tmp file, open
 * $VISUAL || $EDITOR || vi on it (blocking), read the result back. The app is
 * responsible for raw-mode juggling around the call.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type EditorResult = { ok: true; text: string } | { ok: false; error: string };

/** Split an editor env value into argv parts ("code --wait" → ["code", "--wait"]). */
export function parseEditorCommand(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/** Open `text` in the user's editor and return the edited content. */
export function openInExternalEditor(text: string): EditorResult {
  const file = join(
    tmpdir(),
    `seekforge-edit-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  try {
    writeFileSync(file, text, "utf8");
    const [cmd, ...args] = parseEditorCommand(
      process.env.VISUAL || process.env.EDITOR || "vi",
    );
    if (!cmd) return { ok: false, error: "no editor configured" };
    const r = spawnSync(cmd, [...args, file], { stdio: "inherit" });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: `${cmd} exited with status ${r.status}` };
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // tmp file may never have been written; nothing to clean up
    }
  }
}
