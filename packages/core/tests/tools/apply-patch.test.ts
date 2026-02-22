import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

const FILE = [
  "function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "function sub(a, b) {",
  "  return a - b;",
  "}",
  "",
].join("\n");

function setup(): { ws: string; file: string } {
  const ws = makeWorkspace();
  const file = path.join(ws, "math.js");
  fs.writeFileSync(file, FILE);
  return { ws, file };
}

describe("apply_patch", () => {
  it("applies a single edit", async () => {
    const { ws, file } = setup();
    const res = await dispatcher.execute(
      call("apply_patch", {
        path: "math.js",
        edits: [{ oldString: "return a + b;", newString: "return a + b + 0;" }],
      }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ path: "math.js", editsApplied: 1 });
    expect(fs.readFileSync(file, "utf8")).toContain("return a + b + 0;");
  });

  it("applies multiple edits atomically — a late failure writes nothing", async () => {
    const { ws, file } = setup();
    const res = await dispatcher.execute(
      call("apply_patch", {
        path: "math.js",
        edits: [
          { oldString: "return a + b;", newString: "return a + b + 0;" },
          { oldString: "DOES NOT EXIST", newString: "x" },
        ],
      }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("no_match");
    // First edit must NOT have been persisted.
    expect(fs.readFileSync(file, "utf8")).toBe(FILE);
  });

  it("returns a closest-region hint on no_match", async () => {
    const { ws } = setup();
    const res = await dispatcher.execute(
      call("apply_patch", {
        path: "math.js",
        edits: [{ oldString: "  return a * b;", newString: "x" }],
      }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("no_match");
    const detail = res.error?.detail as { hint: string };
    expect(detail.hint).toContain("return a + b;");
  });

  it("rejects ambiguous edits with the match count", async () => {
    const { ws, file } = setup();
    const res = await dispatcher.execute(
      call("apply_patch", {
        path: "math.js",
        edits: [{ oldString: "function ", newString: "async function " }],
      }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("ambiguous");
    const detail = res.error?.detail as { matchCount: number };
    expect(detail.matchCount).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe(FILE);
  });

  it("fails with not_found on a missing file", async () => {
    const { ws } = setup();
    const res = await dispatcher.execute(
      call("apply_patch", { path: "nope.js", edits: [{ oldString: "a", newString: "b" }] }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
  });
});
