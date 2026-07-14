import { describe, expect, it } from "vitest";
import { activeChat, activeTabId, initialTabs, tabLabels, tabsReducer } from "../tabs.js";

describe("tabsReducer", () => {
  it("routes chat actions by tab ID even after switching away", () => {
    let s = initialTabs("m");
    s = tabsReducer(s, { type: "tab-new", model: "m" }); // tab 2 active
    const tab1 = s.tabs[0]!.id;
    s = tabsReducer(s, { type: "chat", tabId: tab1, action: { type: "notice", text: "bg" } });
    expect(s.tabs[0]!.chat.items).toHaveLength(1);
    expect(s.tabs[1]!.chat.items).toHaveLength(0);
    expect(activeChat(s).items).toHaveLength(0); // still viewing tab 2
  });

  it("drops actions for closed tabs instead of crashing", () => {
    let s = initialTabs("m");
    s = tabsReducer(s, { type: "tab-new", model: "m" });
    const tab2 = activeTabId(s);
    s = tabsReducer(s, { type: "tab-close" });
    const before = s;
    s = tabsReducer(s, { type: "chat", tabId: tab2, action: { type: "notice", text: "ghost" } });
    expect(s).toBe(before);
  });

  it("names a tab from its first user message, capped", () => {
    let s = initialTabs("m");
    const id = activeTabId(s);
    s = tabsReducer(s, { type: "chat", tabId: id, action: { type: "user", text: "fix the flaky   renderer test please" } });
    expect(s.tabs[0]!.name).toBe("fix the flaky re");
    s = tabsReducer(s, { type: "chat", tabId: id, action: { type: "user", text: "second message" } });
    expect(s.tabs[0]!.name).toBe("fix the flaky re"); // name sticks
  });

  it("caps tab names without splitting a grapheme", () => {
    let s = initialTabs("m");
    const id = activeTabId(s);
    const family = "👨‍👩‍👧‍👦";
    s = tabsReducer(s, {
      type: "chat",
      tabId: id,
      action: { type: "user", text: `${"a".repeat(15)}${family}z` },
    });
    expect(s.tabs[0]!.name).toBe(`${"a".repeat(15)}${family}`);
  });

  it("new/next/switch/close manage the active index; the last tab cannot close", () => {
    let s = initialTabs("m");
    s = tabsReducer(s, { type: "tab-new", model: "m" });
    s = tabsReducer(s, { type: "tab-new", model: "m" });
    expect(s.tabs).toHaveLength(3);
    expect(s.active).toBe(2);
    s = tabsReducer(s, { type: "tab-next" });
    expect(s.active).toBe(0);
    s = tabsReducer(s, { type: "tab-switch", index: 1 });
    expect(s.active).toBe(1);
    s = tabsReducer(s, { type: "tab-close" });
    expect(s.tabs).toHaveLength(2);
    s = tabsReducer(s, { type: "tab-close" });
    expect(s.tabs).toHaveLength(1);
    s = tabsReducer(s, { type: "tab-close" });
    expect(s.tabs).toHaveLength(1); // floor
    expect(tabLabels(s)).toHaveLength(1);
  });
});
