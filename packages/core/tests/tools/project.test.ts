import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

describe("project metadata tools", () => {
  it("ignores malformed package.json fields instead of throwing", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(
      path.join(ws, "package.json"),
      JSON.stringify({ packageManager: 42, scripts: ["not", "a", "map"], dependencies: null }),
    );

    const detected = await dispatcher.execute(call("detect_project"), makeCtx(ws));
    const scripts = await dispatcher.execute(call("list_scripts"), makeCtx(ws));

    expect(detected.ok).toBe(true);
    expect((detected.data as { packageManager?: string }).packageManager).toBeUndefined();
    expect(scripts).toMatchObject({ ok: true, data: { scripts: [] } });
  });

  it("does not follow a package.json symlink outside the workspace", async () => {
    const ws = makeWorkspace();
    const outside = `${ws}-outside-package.json`;
    try {
      fs.writeFileSync(outside, JSON.stringify({ name: "outside", scripts: { leaked: "echo no" } }));
      fs.symlinkSync(outside, path.join(ws, "package.json"));

      const result = await dispatcher.execute(call("list_scripts"), makeCtx(ws));

      expect(result).toMatchObject({ ok: true, data: { scripts: [] } });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("ignores package.json files larger than the metadata read limit", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ padding: "x".repeat(1024 * 1024) }));

    const result = await dispatcher.execute(call("list_scripts"), makeCtx(ws));

    expect(result).toMatchObject({ ok: true, data: { scripts: [] } });
  });
});
