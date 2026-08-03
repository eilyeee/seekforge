import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "../components/Sidebar";
import { VIEW_ITEMS } from "../components/CommandPalette";
import { common } from "../lib/i18n/common";
import type { View } from "../store";

/**
 * A view is only reachable if it is registered in every place that can reach
 * it. The sidebar, the ⌘K palette and both locale tables are edited separately,
 * so a new view lands half-wired unless something checks all four.
 */

const ORCHESTRATION: View = "orchestration";

describe("the orchestration view is reachable", () => {
  it("appears in the sidebar", () => {
    const views = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.view));
    expect(views).toContain(ORCHESTRATION);
  });

  it("appears in the command palette", () => {
    expect(VIEW_ITEMS.map((entry) => entry.view)).toContain(ORCHESTRATION);
  });

  it("is labelled in both locales", () => {
    expect(common.en["nav.orchestration"]).toBeTruthy();
    expect(common.zh["nav.orchestration"]).toBeTruthy();
    expect(common.en["nav.orchestration"]).not.toBe(common.zh["nav.orchestration"]);
  });

  it("names every view the sidebar offers in both locales", () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(common.en[item.key as keyof typeof common.en], `${item.key} (en)`).toBeTruthy();
        expect(common.zh[item.key as keyof typeof common.en], `${item.key} (zh-CN)`).toBeTruthy();
      }
    }
  });
});
