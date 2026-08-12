import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEngineeringGraphWorkspaces } from "../../src/agent/graph-run-options.js";
import type { EngineeringGraphDefinition } from "../../src/agent/graph-contract.js";

/**
 * Containment of a Graph node's workspace was checked twice, against two
 * different spellings of the same path: once with `relative()` on the raw
 * input, and again on the realpath. The root is always realpath'd, so any
 * workspace reached through a symlinked ancestor failed the first check and
 * would have passed the second — which on macOS is every `/var/folders` temp
 * directory, since `/var` is a symlink to `/private/var`.
 */
describe("Graph node workspace containment", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seekforge-graph-contain-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const definition = (workspace: string): EngineeringGraphDefinition =>
    ({
      graphId: "g",
      nodes: [{ id: "n", kind: "function", handler: "h", workspace }],
    }) as unknown as EngineeringGraphDefinition;

  it("accepts a workspace reached through a symlinked ancestor", () => {
    // `root` itself is under /var on macOS, so an absolute path built from the
    // un-realpath'd root is exactly the shape that used to be refused.
    const real = join(root, "work");
    mkdirSync(real);
    const workspaces = resolveEngineeringGraphWorkspaces(root, definition(real));
    expect(workspaces.get("n")).toBeDefined();
  });

  it("still refuses a workspace outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "seekforge-graph-outside-"));
    try {
      expect(() => resolveEngineeringGraphWorkspaces(root, definition(outside))).toThrow(/escapes the graph workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still refuses a symlink whose target escapes the root", () => {
    // The leaf must be a physical directory: resolving it first and only then
    // checking containment would let a link inside the root stand in for a
    // directory outside it.
    const outside = mkdtempSync(join(tmpdir(), "seekforge-graph-escape-"));
    const link = join(root, "link");
    try {
      symlinkSync(outside, link, "dir");
      expect(() => resolveEngineeringGraphWorkspaces(root, definition(link))).toThrow(/must be a physical directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
