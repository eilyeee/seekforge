import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { PermissionRequest } from "@seekforge/shared";

// Desktop tests run in the node environment with no react-dom, so the keyboard
// useEffect cannot run through React's hook dispatcher. Stub it to a no-op — we
// only assert the returned element tree (presentation), not effect behaviour.
// useState is also stubbed to avoid dispatcher errors in function-call testing.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => {},
    useState: <T>() => [null as unknown as T, vi.fn()] as const,
    // useT() uses these; in renderer-free mode resolve them synchronously.
    useMemo: <T>(fn: () => T) => fn(),
    useSyncExternalStore: <T>(_sub: unknown, getSnapshot: () => T) => getSnapshot(),
    default: { ...actual, useEffect: () => {} },
  };
});

const { PermissionModal } = await import("./PermissionModal");
const { DiffBlock } = await import("../DiffBlock");
// Pin English so assertions are deterministic regardless of the machine locale
// (Node's navigator.language follows the OS, which detectLocale would honor).
const { setLocale } = await import("../../lib/i18n");
setLocale("en");

/**
 * Renderer-free assertions (desktop tests run in the node environment with no
 * react-dom). We call the component to get its top-level React element and walk
 * the plain element tree it returns — collecting text, component types, and the
 * onClick handlers wired to the footer buttons — to prove the preview branch
 * shows the diff and an Accept/Reject pair wired to onRespond.
 */
type Collected = { text: string[]; types: unknown[]; clicks: Array<() => void> };

function walk(node: unknown, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, acc);
    return;
  }
  if (typeof node === "object" && "type" in (node as Record<string, unknown>)) {
    const el = node as ReactElement & { props: Record<string, unknown> };
    acc.types.push(el.type);
    if (typeof el.props.onClick === "function") acc.clicks.push(el.props.onClick as () => void);
    // Walk title/footer/children — Modal receives all three as element props.
    walk(el.props.title, acc);
    walk(el.props.footer, acc);
    walk(el.props.children, acc);
  }
}

function inspect(request: PermissionRequest): Collected & { onResponds: boolean[] } {
  const onResponds: boolean[] = [];
  const onRespond = (...args: unknown[]): void => {
    onResponds.push(args[0] as boolean);
  };
  const acc: Collected = { text: [], types: [], clicks: [] };
  walk(PermissionModal({ request, onRespond }), acc);
  return { ...acc, onResponds };
}

// Helper: collect all onRespond calls with full args (approved, remember, selectedHunks).
function inspectCalls(request: PermissionRequest): Array<[boolean, undefined | "session", undefined | number[]]> {
  const calls: Array<[boolean, undefined | "session", undefined | number[]]> = [];
  const onRespond = (approved: boolean, remember?: "session", selectedHunks?: number[]): void => {
    calls.push([approved, remember, selectedHunks]);
  };
  const acc: Collected = { text: [], types: [], clicks: [] };
  walk(PermissionModal({ request, onRespond }), acc);
  for (const click of acc.clicks) click();
  return calls;
}

describe("PermissionModal — edit-review preview", () => {
  const previewReq: PermissionRequest = {
    toolName: "apply_patch",
    permission: "write",
    description: "Apply 1 edit(s) to src/a.ts",
    path: "src/a.ts",
    preview: {
      path: "src/a.ts",
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
    },
  };

  it("renders a DiffBlock with the preview diff and a 'Review change' title", () => {
    const { text, types } = inspect(previewReq);
    expect(types).toContain(DiffBlock);
    expect(text.join("")).toContain("Review change: src/a.ts");
    expect(text.join("")).toContain("Accept");
    expect(text.join("")).toContain("Reject");
  });

  it("passes the diff text to DiffBlock", () => {
    let diffProp: string | undefined;
    const acc: Collected = { text: [], types: [], clicks: [] };
    const seen = (node: unknown): void => {
      if (node && typeof node === "object" && "type" in (node as Record<string, unknown>)) {
        const el = node as { type: unknown; props: Record<string, unknown> };
        if (el.type === DiffBlock) diffProp = el.props.diff as string;
        walk(el.props.title, acc);
        walk(el.props.footer, acc);
        // also descend children to reach DiffBlock
        const kids = el.props.children;
        if (Array.isArray(kids)) kids.forEach(seen);
        else seen(kids);
      }
    };
    seen(PermissionModal({ request: previewReq, onRespond: () => {} }));
    expect(diffProp).toContain("+new");
    expect(diffProp).toContain("-old");
  });

  it("wires Reject to onRespond(false) and Accept to onRespond(true)", () => {
    const { clicks, onResponds } = inspect(previewReq);
    // Footer buttons (Reject first, Accept second). Modal's onDismiss also
    // closes over onRespond(false); filter to the button handlers by invoking
    // all collected onClick handlers and checking the recorded responses.
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    for (const click of clicks) click();
    expect(onResponds).toContain(true);
    expect(onResponds).toContain(false);
  });

  it("falls back to the plain allow/deny modal when there is no preview", () => {
    const req: PermissionRequest = {
      toolName: "run_command",
      permission: "execute",
      description: "Run a command",
      command: "rm -rf build",
    };
    const { text, types } = inspect(req);
    expect(types).not.toContain(DiffBlock);
    const joined = text.join("");
    expect(joined).toContain("Permission required");
    expect(joined).toContain("Allow");
    expect(joined).toContain("Deny");
    expect(joined).toContain("rm -rf build");
  });

  const plainReq: PermissionRequest = {
    toolName: "run_command",
    permission: "execute",
    description: "Run a command",
    command: "rm -rf build",
  };

  it("renders three buttons: Deny / Allow for session / Allow once", () => {
    const { text } = inspect(plainReq);
    const joined = text.join("");
    expect(joined).toContain("Deny");
    expect(joined).toContain("Allow for session");
    expect(joined).toContain("Allow once");
  });

  it("'Allow for session' calls onRespond(true, 'session')", () => {
    const calls: Array<[boolean, "session" | undefined]> = [];
    const onRespond = (approved: boolean, remember?: "session"): void => {
      calls.push([approved, remember]);
    };
    const acc: Collected = { text: [], types: [], clicks: [] };
    // Collect the footer button handlers, then invoke each and inspect calls.
    walk(PermissionModal({ request: plainReq, onRespond }), acc);
    for (const click of acc.clicks) click();
    // Deny -> (false, undefined); Allow for session -> (true, "session");
    // Allow once -> (true, undefined); Modal onDismiss -> (false, undefined).
    expect(calls).toContainEqual([true, "session"]);
    expect(calls).toContainEqual([true, undefined]);
    expect(calls).toContainEqual([false, undefined]);
  });
});

describe("PermissionModal — multi-hunk selection", () => {
  const multiReq: PermissionRequest = {
    toolName: "apply_patch",
    permission: "write",
    description: "Apply 3 edits to src/a.ts",
    path: "src/a.ts",
    preview: {
      path: "src/a.ts",
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,5 +1,6 @@\n+new\n@@ -10,3 +10,4 @@\n change\n@@ -20,2 +21,3 @@\n+another",
    },
    hunks: [
      { index: 0, preview: "@@ -1,5 +1,6 @@\n+new" },
      { index: 1, preview: "@@ -10,3 +10,4 @@\n change" },
      { index: 2, preview: "@@ -20,2 +21,3 @@\n+another" },
    ],
  };

  it("shows a 'Review N edits' title with DiffBlock and per-hunk checkboxes", () => {
    const { text, types } = inspect(multiReq);
    const joined = text.join("");
    // Title mentions the edit count
    expect(joined).toContain("Review 3 edits");
    // DiffBlock is shown for the full diff
    expect(types).toContain(DiffBlock);
    // Each hunk preview appears
    expect(joined).toContain("Edit #1");
    expect(joined).toContain("Edit #2");
    expect(joined).toContain("Edit #3");
    expect(joined).toContain("@@ -1,5 +1,6 @@");
    expect(joined).toContain("@@ -10,3 +10,4 @@");
    expect(joined).toContain("@@ -20,2 +21,3 @@");
    // Checkboxes rendered (input elements in the tree)
    expect(types.filter((t) => t === "input").length).toBeGreaterThanOrEqual(3);
    // Buttons
    expect(joined).toContain("Skip all");
    expect(joined).toContain("Apply all");
    expect(joined).toContain("Apply selected");
  });

  it("'Skip all' calls onRespond(false)", () => {
    const calls = inspectCalls(multiReq);
    expect(calls).toContainEqual([false, undefined, undefined]);
  });

  it("'Apply all' calls onRespond(true, undefined, [0,1,2])", () => {
    const calls = inspectCalls(multiReq);
    expect(calls).toContainEqual([true, undefined, [0, 1, 2]]);
  });

  it("falls back to single-preview UI when hunks has one item", () => {
    const singleHunkReq: PermissionRequest = {
      toolName: "apply_patch",
      permission: "write",
      description: "Apply 1 edit",
      path: "src/a.ts",
      preview: {
        path: "src/a.ts",
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
      },
      hunks: [{ index: 0, preview: "@@ -1,1 +1,1 @@" }],
    };
    const { text } = inspect(singleHunkReq);
    const joined = text.join("");
    // Falls back to the standard preview UI (Accept/Reject), not multi-hunk
    expect(joined).toContain("Review change: src/a.ts");
    expect(joined).toContain("Accept");
    expect(joined).toContain("Reject");
    // Multi-hunk labels should not appear
    expect(joined).not.toContain("Skip all");
    expect(joined).not.toContain("Apply all");
  });
});
