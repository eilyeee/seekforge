import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { PermissionPanel } from "../components/PermissionPanel.js";
import { DiffCard } from "../components/DiffCard.js";

/**
 * Presentation-only assertions over the rendered React element tree (no ink
 * renderer dependency): collect all string text and component types so we can
 * assert the preview branch wires up DiffCard + the accept/reject prompt.
 */
function walk(node: unknown, text: string[], types: unknown[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, text, types);
    return;
  }
  if (typeof node === "object" && "type" in (node as Record<string, unknown>)) {
    const el = node as { type: unknown; props?: { children?: unknown } };
    types.push(el.type);
    walk(el.props?.children, text, types);
  }
}

function inspect(req: PermissionRequest, hunkSelection?: number[]): { text: string; types: unknown[] } {
  const text: string[] = [];
  const types: unknown[] = [];
  walk(PermissionPanel({ request: req, hunkSelection }), text, types);
  return { text: text.join(""), types };
}

describe("PermissionPanel — edit-review preview", () => {
  it("renders a DiffCard and accept/reject prompt when preview is present", () => {
    const req: PermissionRequest = {
      toolName: "apply_patch",
      permission: "write",
      description: "Apply 1 edit(s) to a.txt",
      path: "a.txt",
      preview: {
        path: "a.txt",
        diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
      },
    };
    const { text, types } = inspect(req);
    expect(types).toContain(DiffCard);
    expect(text).toContain("Review change:");
    expect(text).toContain("a.txt");
    expect(text).toContain("Apply this change? y accept · n reject");
  });

  it("keeps the raw command/path prompt when no preview is present", () => {
    const req: PermissionRequest = {
      toolName: "run_command",
      permission: "execute",
      description: "Run a command",
      command: "rm -rf build",
    };
    const { text, types } = inspect(req);
    expect(types).not.toContain(DiffCard);
    expect(text).toContain("Permission required");
    expect(text).toContain("rm -rf build");
    expect(text).toContain("any other key deny");
  });
});

describe("PermissionPanel — multi-hunk selection", () => {
  const multiHunkReq: PermissionRequest = {
    toolName: "apply_patch",
    permission: "write",
    description: "Apply 3 edit(s) to a.txt",
    path: "a.txt",
    preview: {
      path: "a.txt",
      diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
    },
    hunks: [
      { index: 0, preview: "@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n context" },
      { index: 1, preview: "@@ -10,2 +10,3 @@\n-foo\n+bar\n+baz" },
      { index: 2, preview: "@@ -20,1 +20,1 @@\n-x\n+y" },
    ],
  };

  it("renders per-hunk checkboxes with [x] when all hunks selected", () => {
    const { text, types } = inspect(multiHunkReq, [0, 1, 2]);
    expect(text).toContain("Review change:");
    expect(text).toContain("a.txt");
    expect(text).toContain("Hunk 1");
    expect(text).toContain("Hunk 2");
    expect(text).toContain("Hunk 3");
    expect(text).toContain("[x]");
    expect(text).toContain("number key toggle hunk");
    expect(text).toContain("y confirm");
    expect(text).toContain("n deny");
    expect(types).not.toContain(DiffCard);
  });

  it("renders [ ] for hunks not in selection and [x] for selected ones", () => {
    const { text } = inspect(multiHunkReq, [0, 2]);
    // Hunk 1 and Hunk 3 are selected, Hunk 2 is not.
    const xCount = (text.match(/\[x\]/g) ?? []).length;
    const emptyCount = (text.match(/\[ \]/g) ?? []).length;
    expect(xCount).toBe(2);
    expect(emptyCount).toBe(1);
  });

  it("renders hunk preview text truncated to 200 chars", () => {
    const { text } = inspect(multiHunkReq, [0, 1, 2]);
    // Each hunk preview should appear in the rendered text.
    expect(text).toContain("context");
    expect(text).toContain("-old line");
    expect(text).toContain("+new line");
  });

  it("single-hunk request with hunks behaves as preview mode (no checkboxes)", () => {
    const singleHunkReq: PermissionRequest = {
      toolName: "apply_patch",
      permission: "write",
      description: "Apply 1 edit(s) to a.txt",
      path: "a.txt",
      preview: {
        path: "a.txt",
        diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
      },
      hunks: [{ index: 0, preview: "@@ -1,1 +1,1 @@\n-old\n+new" }],
    };
    const { text, types } = inspect(singleHunkReq);
    expect(types).toContain(DiffCard);
    expect(text).toContain("Apply this change? y accept · n reject");
    expect(text).not.toContain("number key toggle hunk");
  });
});
