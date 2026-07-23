import { describe, expect, it } from "vitest";
import { formatPluginLines } from "../plugins-surface.js";

describe("formatPluginLines", () => {
  it("shows scope, digest approval status, and invalid errors", () => {
    expect(
      formatPluginLines([
        {
          id: "demo",
          scope: "global",
          path: "/tmp/demo",
          status: "enabled",
          manifest: { apiVersion: 1, id: "demo", name: "Demo", version: "1.2.3", description: "tools" },
        },
        { id: "broken", scope: "project", path: "/tmp/broken", status: "invalid", error: "bad manifest" },
      ]),
    ).toEqual(["demo@1.2.3  (global)  [enabled]  tools", "broken  (project)  [invalid]  bad manifest"]);
  });
});
