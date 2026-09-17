/**
 * Pure model for the Hooks editor. Hook entries are edited generically: the
 * three fields this build understands (command, match, pattern) get inputs,
 * and every other field — `type`, `url`, `prompt`, `timeout`, whatever a newer
 * core adds — is kept verbatim and shown as a JSON value the user can edit.
 * Stages this build does not know are kept too, so saving never drops them.
 */
import { HOOK_STAGES } from "../types";

/** A hook entry exactly as stored (known and unknown fields alike). */
export type StoredHookEntry = Record<string, unknown>;
/** The user-owned hooks block: stage → entries. */
export type StoredHooks = Record<string, StoredHookEntry[]>;

/** Stages where a non-zero exit (or JSON deny) blocks the tool/run. */
export const BLOCKING_HOOK_STAGES: ReadonlySet<string> = new Set(["preToolUse", "userPromptSubmit"]);

const KNOWN_FIELDS = new Set(["command", "match", "pattern"]);

/** An extra (non-form) field: its key and JSON-encoded value. */
export type ExtraFieldRow = { key: string; json: string };

export type HookDraftEntry = {
  /** Client-only React key; never sent. */
  id: string;
  command: string;
  match: string;
  pattern: string;
  extra: ExtraFieldRow[];
};

export type HooksDraft = { stages: string[]; entries: Record<string, HookDraftEntry[]> };

let draftSeq = 0;
export function newHookEntryId(): string {
  draftSeq += 1;
  return `hook-${draftSeq}`;
}

export function emptyHookEntry(): HookDraftEntry {
  return { id: newHookEntryId(), command: "", match: "", pattern: "", extra: [] };
}

function stringField(entry: StoredHookEntry, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : "";
}

/** Known stages in their canonical order, then any stored stage this build does not know. */
export function toHooksDraft(hooks: StoredHooks): HooksDraft {
  const known: readonly string[] = HOOK_STAGES;
  const stages = [...known, ...Object.keys(hooks).filter((stage) => !known.includes(stage))];
  const entries: Record<string, HookDraftEntry[]> = {};
  for (const stage of stages) {
    entries[stage] = (Array.isArray(hooks[stage]) ? hooks[stage] : []).map((entry) => ({
      id: newHookEntryId(),
      command: stringField(entry, "command"),
      match: stringField(entry, "match"),
      pattern: stringField(entry, "pattern"),
      extra: Object.entries(entry)
        .filter(([key, value]) => !KNOWN_FIELDS.has(key) || (value !== undefined && typeof value !== "string"))
        .map(([key, value]) => ({ key, json: JSON.stringify(value) ?? "null" })),
    }));
  }
  return { stages, entries };
}

export type HooksBuildResult = { ok: true; hooks: StoredHooks } | { ok: false; stage: string; error: string };

/**
 * Back to the stored shape. An entry the user left completely blank is
 * dropped; anything else is kept, and an extra value that is not valid JSON
 * stops the save instead of being silently discarded.
 */
export function fromHooksDraft(draft: HooksDraft): HooksBuildResult {
  const hooks: StoredHooks = {};
  for (const stage of draft.stages) {
    const list: StoredHookEntry[] = [];
    for (const entry of draft.entries[stage] ?? []) {
      const extras = entry.extra.filter((row) => row.key.trim() !== "");
      const command = entry.command.trim();
      if (command === "" && extras.length === 0 && entry.match.trim() === "" && entry.pattern.trim() === "") continue;
      const stored: StoredHookEntry = {};
      if (command !== "") stored.command = command;
      if (entry.match.trim() !== "") stored.match = entry.match.trim();
      if (entry.pattern.trim() !== "") stored.pattern = entry.pattern.trim();
      for (const row of extras) {
        const key = row.key.trim();
        if (KNOWN_FIELDS.has(key) && stored[key] !== undefined) {
          return { ok: false, stage, error: `field "${key}" is set twice` };
        }
        try {
          stored[key] = JSON.parse(row.json) as unknown;
        } catch {
          return { ok: false, stage, error: `field "${key}" is not valid JSON` };
        }
      }
      list.push(stored);
    }
    if (list.length > 0) hooks[stage] = list;
  }
  return { ok: true, hooks };
}
