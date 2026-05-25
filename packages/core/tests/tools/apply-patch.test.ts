import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
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

  describe("per-hunk selection", () => {
    const MULTI_EDITS = [
      { oldString: "  return a + b;", newString: "  return a + b + 0;" }, // index 0
      { oldString: "  return a - b;", newString: "  return a - b - 0;" }, // index 1
      { oldString: "  return a + b;", newString: "  return add(a, b);" }, // index 2 (same as 0 after edit 0 applied)
    ];

    it("populates hunks on the PermissionRequest when >1 edit", async () => {
      const { ws } = setup();
      const requests: PermissionRequest[] = [];
      const confirm = async (req: PermissionRequest): Promise<ConfirmResult> => {
        requests.push(req);
        return true;
      };
      // Two edits that both succeed: triggers an actual permission prompt.
      const res = await dispatcher.execute(
        call("apply_patch", {
          path: "math.js",
          edits: [
            { oldString: "  return a + b;", newString: "  return a + b + 0;" },
            { oldString: "  return a - b;", newString: "  return a - b - 0;" },
          ],
        }),
        makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm }),
      );
      expect(res.ok).toBe(true);
      expect(requests).toHaveLength(1);
      const req = requests[0]!;
      expect(req.toolName).toBe("apply_patch");
      expect(req.hunks).toBeDefined();
      expect(req.hunks).toHaveLength(2);
      expect(req.hunks![0]!.index).toBe(0);
      expect(req.hunks![0]!.preview).toContain("return a + b;");
      expect(req.hunks![1]!.index).toBe(1);
      expect(req.hunks![1]!.preview).toContain("return a - b;");
    });

    it("does not populate hunks for a single edit", async () => {
      const { ws } = setup();
      const requests: PermissionRequest[] = [];
      const confirm = async (req: PermissionRequest): Promise<ConfirmResult> => {
        requests.push(req);
        return true;
      };
      const res = await dispatcher.execute(
        call("apply_patch", {
          path: "math.js",
          edits: [{ oldString: "  return a + b;", newString: "  return a + b + 0;" }],
        }),
        makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm }),
      );
      expect(res.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.hunks).toBeUndefined();
    });

    it("applies only selected hunks when confirm returns selectedHunks", async () => {
      const { ws, file } = setup();
      const confirm = async (): Promise<ConfirmResult> => ({
        allow: true,
        selectedHunks: [0, 1],
      });
      const res = await dispatcher.execute(
        call("apply_patch", {
          path: "math.js",
          edits: MULTI_EDITS,
        }),
        makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm }),
      );
      expect(res.ok).toBe(true);
      // Only edits 0 and 1 should have been applied (not edit 2).
      expect((res.data as { editsApplied: number }).editsApplied).toBe(2);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("return a + b + 0;");
      expect(content).toContain("return a - b - 0;");
      expect(content).not.toContain("return add(a, b);");
    });

    it("applies a single hunk from a multi-edit patch", async () => {
      const { ws, file } = setup();
      const confirm = async (): Promise<ConfirmResult> => ({
        allow: true,
        selectedHunks: [0],
      });
      const res = await dispatcher.execute(
        call("apply_patch", {
          path: "math.js",
          edits: [
            { oldString: "  return a + b;", newString: "  return a + b + 0;" },
            { oldString: "  return a - b;", newString: "  return a - b - 0;" },
          ],
        }),
        makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm }),
      );
      expect(res.ok).toBe(true);
      expect((res.data as { editsApplied: number }).editsApplied).toBe(1);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("return a + b + 0;");
      expect(content).toContain("return a - b;"); // unchanged
    });

    it("applies zero edits when selectedHunks is empty", async () => {
      const { ws, file } = setup();
      const confirm = async (): Promise<ConfirmResult> => ({
        allow: true,
        selectedHunks: [],
      });
      const res = await dispatcher.execute(
        call("apply_patch", {
          path: "math.js",
          edits: [
            { oldString: "  return a + b;", newString: "  return a + b + 0;" },
          ],
        }),
        makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm }),
      );
      expect(res.ok).toBe(true);
      expect((res.data as { editsApplied: number }).editsApplied).toBe(0);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toBe(FILE); // unchanged
    });

    it("backward compat: boolean confirm applies all edits", async () => {
      const { ws, file } = setup();
      const res = await dispatcher.execute(
        call("apply_patch", {
          path: "math.js",
          edits: [
            { oldString: "  return a + b;", newString: "  return a + b + 0;" },
            { oldString: "  return a - b;", newString: "  return a - b - 0;" },
          ],
        }),
        makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm: async () => true }),
      );
      expect(res.ok).toBe(true);
      expect((res.data as { editsApplied: number }).editsApplied).toBe(2);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("return a + b + 0;");
      expect(content).toContain("return a - b - 0;");
    });
  });
});
