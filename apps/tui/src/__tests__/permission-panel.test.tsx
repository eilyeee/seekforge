import React from "react";
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

function inspect(req: PermissionRequest): { text: string; types: unknown[] } {
  const text: string[] = [];
  const types: unknown[] = [];
  walk(PermissionPanel({ request: req }), text, types);
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
