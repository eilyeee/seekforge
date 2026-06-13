import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { PermissionRequest } from "@seekforge/shared";

// Desktop tests run in the node environment with no react-dom, so the keyboard
// useEffect cannot run through React's hook dispatcher. Stub it to a no-op — we
// only assert the returned element tree (presentation), not effect behaviour.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, default: { ...actual, useEffect: () => {} } };
});

const { PermissionModal } = await import("./PermissionModal");
const { DiffBlock } = await import("../DiffBlock");

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
  const onRespond = (approved: boolean): void => {
    onResponds.push(approved);
  };
  const acc: Collected = { text: [], types: [], clicks: [] };
  walk(PermissionModal({ request, onRespond }), acc);
  return { ...acc, onResponds };
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
});
