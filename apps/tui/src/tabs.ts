/**
 * Multi-tab state (CodeWhale-style): each tab owns a full ChatState, so
 * independent sessions run in parallel — a run started in tab 1 keeps
 * dispatching into tab 1 after you switch away (actions are routed by tab
 * ID, not index). Pure reducer over the per-tab chatReducer.
 */

import { chatReducer, initialState, type ChatAction, type ChatState } from "./model.js";
import { graphemeBoundaries } from "./editor.js";

export type Tab = { id: number; name: string; chat: ChatState };

export type TabsState = {
  tabs: Tab[];
  /** Index into tabs of the visible tab. */
  active: number;
  /** Monotonic id source. */
  nextId: number;
};

export type TabsAction =
  | { type: "chat"; tabId: number; action: ChatAction }
  | { type: "tab-new"; model: string }
  | { type: "tab-close" }
  | { type: "tab-switch"; index: number }
  | { type: "tab-next" };

const DEFAULT_NAME = "·";
const NAME_MAX = 16;

function truncateName(text: string): string {
  const boundaries = graphemeBoundaries(text);
  return boundaries.length - 1 <= NAME_MAX ? text : text.slice(0, boundaries[NAME_MAX]);
}

export function initialTabs(model: string): TabsState {
  return { tabs: [{ id: 1, name: DEFAULT_NAME, chat: initialState(model) }], active: 0, nextId: 2 };
}

export function activeChat(s: TabsState): ChatState {
  return (s.tabs[s.active] ?? s.tabs[0]!).chat;
}

export function activeTabId(s: TabsState): number {
  return (s.tabs[s.active] ?? s.tabs[0]!).id;
}

/** Tab-strip labels: "1·fix the bug" with the active one marked upstream. */
export function tabLabels(s: TabsState): string[] {
  return s.tabs.map((t, i) => `${i + 1}·${t.name}`);
}

export function tabsReducer(s: TabsState, a: TabsAction): TabsState {
  switch (a.type) {
    case "chat": {
      const idx = s.tabs.findIndex((t) => t.id === a.tabId);
      if (idx < 0) return s; // tab was closed; drop the straggler action
      const tab = s.tabs[idx]!;
      const chat = chatReducer(tab.chat, a.action);
      if (chat === tab.chat) return s;
      // First user message names the tab.
      let name = tab.name;
      if (name === DEFAULT_NAME && a.action.type === "user") {
        name = truncateName(a.action.text.replace(/\s+/g, " ")) || DEFAULT_NAME;
      }
      const tabs = s.tabs.slice();
      tabs[idx] = { ...tab, chat, name };
      return { ...s, tabs };
    }

    case "tab-new": {
      const tab: Tab = { id: s.nextId, name: DEFAULT_NAME, chat: initialState(a.model) };
      return { ...s, tabs: [...s.tabs, tab], active: s.tabs.length, nextId: s.nextId + 1 };
    }

    case "tab-close": {
      if (s.tabs.length <= 1) return s; // always keep one tab
      const tabs = s.tabs.filter((_, i) => i !== s.active);
      return { ...s, tabs, active: Math.min(s.active, tabs.length - 1) };
    }

    case "tab-switch": {
      if (a.index < 0 || a.index >= s.tabs.length) return s;
      return { ...s, active: a.index };
    }

    case "tab-next":
      return { ...s, active: (s.active + 1) % s.tabs.length };

    default:
      return s;
  }
}
