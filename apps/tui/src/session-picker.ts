/**
 * The /sessions picker: search, preview and inline rename over the stored
 * sessions. State and key handling are pure; the app applies the outcomes
 * (resume, fork, rename) through core.
 */

import { listSessions, loadSessionMessages, sessionName, sessionTitle, type SessionMeta } from "@seekforge/core";
import { clipLine } from "@seekforge/shared/format";
import { relativeAge } from "./format.js";
import type { KeyStroke } from "./keymap.js";

/** Longest name the rename input accepts (core caps what it stores, too). */
export const MAX_SESSION_NAME_CHARS = 120;

export type SessionRow = {
  id: string;
  /** Display title: the name when set, else the summary or task line. */
  title: string;
  named: boolean;
  task: string;
  status: SessionMeta["status"];
  updatedAt: string;
  costUsd?: number;
};

export type SessionPickerState = {
  rows: SessionRow[];
  query: string;
  /** Typing goes to the search field. */
  searching: boolean;
  /** Index into the FILTERED rows. */
  index: number;
  /** Inline rename of one session. */
  renaming?: { id: string; text: string };
};

export function loadSessionRows(workspace: string): SessionRow[] {
  return listSessions(workspace).map((meta) => ({
    id: meta.id,
    title: sessionTitle(workspace, meta.id),
    named: sessionName(workspace, meta.id) !== undefined,
    task: meta.task,
    status: meta.status,
    updatedAt: meta.updatedAt,
    ...(meta.usage ? { costUsd: meta.usage.costUsd } : {}),
  }));
}

export function initialSessionPicker(rows: SessionRow[]): SessionPickerState {
  return { rows, query: "", searching: false, index: 0 };
}

/** Rows whose id, title or task contains every word of the query (case-insensitive). */
export function filterSessions(rows: readonly SessionRow[], query: string): SessionRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.id}\n${row.title}\n${row.task}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function visibleSessions(state: SessionPickerState): SessionRow[] {
  return filterSessions(state.rows, state.query);
}

export function selectedSession(state: SessionPickerState): SessionRow | undefined {
  return visibleSessions(state)[state.index];
}

/** One list line: "★ title  [status]  2h ago  $0.0123  id". */
export function sessionLine(row: SessionRow, now: Date | number = Date.now()): string {
  const cost = row.costUsd === undefined ? "—" : `$${row.costUsd.toFixed(4)}`;
  const title = clipLine(row.title.replace(/\s+/g, " "), 48);
  return `${row.named ? "★ " : ""}${title}  [${row.status}]  ${relativeAge(row.updatedAt, now)}  ${cost}  ${row.id}`;
}

export type SessionPreview = {
  firstPrompt?: string;
  lastReply?: string;
  messages: number;
};

/** The first user prompt and the last assistant reply of a stored session. */
export function readSessionPreview(workspace: string, id: string): SessionPreview {
  let messages: ReturnType<typeof loadSessionMessages>;
  try {
    messages = loadSessionMessages(workspace, id);
  } catch {
    return { messages: 0 };
  }
  const first = messages.find((m) => m.role === "user" && m.content.trim() !== "");
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "");
  return {
    ...(first ? { firstPrompt: first.content.trim() } : {}),
    ...(last ? { lastReply: last.content.trim() } : {}),
    messages: messages.length,
  };
}

export type SessionPickerOutcome =
  | { kind: "update"; state: SessionPickerState }
  | { kind: "resume"; id: string }
  | { kind: "fork"; id: string }
  | { kind: "rename"; id: string; title: string; state: SessionPickerState }
  | { kind: "close" }
  | { kind: "ignore" };

function printable(input: string, stroke: KeyStroke): boolean {
  return stroke.name === undefined && !stroke.ctrl && !stroke.meta && input.length > 0 && !/[\x00-\x1f]/.test(input);
}

function moved(state: SessionPickerState, delta: number): SessionPickerState {
  const count = visibleSessions(state).length;
  if (count === 0) return { ...state, index: 0 };
  return { ...state, index: (((state.index + delta) % count) + count) % count };
}

export function sessionPickerKey(state: SessionPickerState, input: string, stroke: KeyStroke): SessionPickerOutcome {
  if (state.renaming) {
    const renaming = state.renaming;
    if (stroke.name === "escape") {
      const { renaming: _dropped, ...rest } = state;
      return { kind: "update", state: rest };
    }
    if (stroke.name === "return") {
      const { renaming: _done, ...rest } = state;
      return { kind: "rename", id: renaming.id, title: renaming.text, state: rest };
    }
    if (stroke.name === "backspace" || stroke.name === "delete") {
      return {
        kind: "update",
        state: { ...state, renaming: { ...renaming, text: Array.from(renaming.text).slice(0, -1).join("") } },
      };
    }
    if (printable(input, stroke)) {
      const text = Array.from(renaming.text + input)
        .slice(0, MAX_SESSION_NAME_CHARS)
        .join("");
      return { kind: "update", state: { ...state, renaming: { ...renaming, text } } };
    }
    return { kind: "ignore" };
  }

  if (stroke.name === "up") return { kind: "update", state: moved(state, -1) };
  if (stroke.name === "down") return { kind: "update", state: moved(state, 1) };
  if (stroke.name === "pageup") return { kind: "update", state: moved(state, -8) };
  if (stroke.name === "pagedown") return { kind: "update", state: moved(state, 8) };

  if (state.searching) {
    if (stroke.name === "escape") {
      return { kind: "update", state: { ...state, searching: false, query: "", index: 0 } };
    }
    if (stroke.name === "return" || stroke.name === "tab") {
      return { kind: "update", state: { ...state, searching: false } };
    }
    if (stroke.name === "backspace" || stroke.name === "delete") {
      return {
        kind: "update",
        state: { ...state, query: Array.from(state.query).slice(0, -1).join(""), index: 0 },
      };
    }
    if (printable(input, stroke)) return { kind: "update", state: { ...state, query: state.query + input, index: 0 } };
    return { kind: "ignore" };
  }

  if (stroke.name === "escape") {
    // The first Esc clears an active filter; the next one closes.
    if (state.query !== "") return { kind: "update", state: { ...state, query: "", index: 0 } };
    return { kind: "close" };
  }
  const row = selectedSession(state);
  if (stroke.name === "return" || stroke.name === "tab")
    return row ? { kind: "resume", id: row.id } : { kind: "ignore" };
  if (stroke.ctrl || stroke.meta) return { kind: "ignore" };
  if (input === "/") return { kind: "update", state: { ...state, searching: true } };
  if (input === "f" && row) return { kind: "fork", id: row.id };
  if (input === "r" && row) {
    return { kind: "update", state: { ...state, renaming: { id: row.id, text: row.named ? row.title : "" } } };
  }
  return { kind: "ignore" };
}

/** The picker after one row's title changed (the app re-reads it from core). */
export function withRenamedRow(
  state: SessionPickerState,
  id: string,
  title: string,
  named: boolean,
): SessionPickerState {
  return { ...state, rows: state.rows.map((row) => (row.id === id ? { ...row, title, named } : row)) };
}
