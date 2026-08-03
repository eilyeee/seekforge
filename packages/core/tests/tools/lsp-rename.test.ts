import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher, disposeLspServers, type ToolContext } from "../../src/tools/index.js";
import { call, makeCtx } from "./helpers.js";

/**
 * lsp_rename end to end against a scripted stub language server, following the
 * pattern in lsp-session.test.ts: a tiny server is written to a temp bin dir and
 * put on PATH, so the real client, the real dispatcher and the real write path
 * all run — only the server's answers are fixed.
 *
 * What matters here is the order of events: the edit is computed BEFORE the
 * user is asked, the user sees a real diff, and the write is all-or-nothing.
 */

const STUB_SERVER = String.raw`#!/usr/bin/env node
import fs from "node:fs";

const fixture = JSON.parse(fs.readFileSync(process.env.LSP_RENAME_FIXTURE, "utf8"));
let pending = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]));
}

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  } else if (message.method === "textDocument/rename") {
    if (fixture.renameError) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: fixture.renameError } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: fixture.rename ?? null });
    }
  } else if (message.method === "workspace/symbol") {
    send({ jsonrpc: "2.0", id: message.id, result: fixture.symbols ?? [] });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const separator = pending.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = pending.subarray(0, separator).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      pending = pending.subarray(separator + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = separator + 4;
    if (pending.length < start + length) return;
    handle(JSON.parse(pending.subarray(start, start + length).toString("utf8")));
    pending = pending.subarray(start + length);
  }
});
`;

const WIDGET = ["export class Widget {}", "export const make = () => new Widget();", ""].join("\n");
const USES = ["import { Widget } from './widget';", "export const w: Widget = new Widget();", ""].join("\n");

/** An LSP text edit covering `text` on `line` (0-based), replacing it with `newText`. */
function edit(line: number, character: number, length: number, newText: string): Record<string, unknown> {
  return {
    range: { start: { line, character }, end: { line, character: character + length } },
    newText,
  };
}

let root: string;
let workspace: string;
let fixturePath: string;
let savedPath: string | undefined;
let savedFixture: string | undefined;

const uri = (relative: string): string => pathToFileURL(path.join(workspace, relative)).href;

function setFixture(fixture: Record<string, unknown>): void {
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
}

/** Rename `Widget` → `Panel` across both files, as a language server would answer. */
function renameBothFiles(): Record<string, unknown> {
  return {
    changes: {
      [uri("widget.ts")]: [edit(0, 13, 6, "Panel"), edit(1, 30, 6, "Panel")],
      [uri("uses.ts")]: [edit(0, 9, 6, "Panel"), edit(1, 16, 6, "Panel"), edit(1, 29, 6, "Panel")],
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-lsp-rename-"));
  workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(workspace, "widget.ts"), WIDGET);
  fs.writeFileSync(path.join(workspace, "uses.ts"), USES);
  fs.writeFileSync(path.join(bin, "typescript-language-server"), STUB_SERVER, { mode: 0o755 });
  fixturePath = path.join(root, "fixture.json");
  setFixture({});

  savedPath = process.env.PATH;
  savedFixture = process.env.LSP_RENAME_FIXTURE;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
  process.env.LSP_RENAME_FIXTURE = fixturePath;
});

afterEach(async () => {
  await disposeLspServers();
  process.env.PATH = savedPath;
  if (savedFixture === undefined) delete process.env.LSP_RENAME_FIXTURE;
  else process.env.LSP_RENAME_FIXTURE = savedFixture;
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (relative: string): string => fs.readFileSync(path.join(workspace, relative), "utf8");

function ctxWith(overrides: Parameters<typeof makeCtx>[1] = {}): ToolContext {
  return makeCtx(workspace, overrides);
}

const renameCall = (): ReturnType<typeof call> =>
  call("lsp_rename", { path: "widget.ts", line: 1, character: 13, newName: "Panel" });

describe("lsp_rename applies a language server edit", () => {
  it("rewrites every file the server named and reports what it did", async () => {
    setFixture({ rename: renameBothFiles() });
    const checkpoints: Array<{ path: string; before: string | null }> = [];
    const res = await createDefaultDispatcher().execute(
      renameCall(),
      ctxWith({ checkpoint: (p, before) => checkpoints.push({ path: p, before }) }),
    );

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.data).toMatchObject({
      newName: "Panel",
      filesChanged: 2,
      editsApplied: 5,
    });
    expect(read("widget.ts")).toBe(["export class Panel {}", "export const make = () => new Panel();", ""].join("\n"));
    expect(read("uses.ts")).toBe(
      ["import { Panel } from './widget';", "export const w: Panel = new Panel();", ""].join("\n"),
    );
    // Every touched file is checkpointed with its pre-rename content, so
    // `seekforge rewind` can undo the whole rename.
    expect(checkpoints.map((c) => c.path).sort()).toEqual(["uses.ts", "widget.ts"]);
    expect(checkpoints.find((c) => c.path === "widget.ts")?.before).toBe(WIDGET);
  });

  it("shows the reviewer the real diff and one hunk per file, before writing", async () => {
    setFixture({ rename: renameBothFiles() });
    const requests: PermissionRequest[] = [];
    const res = await createDefaultDispatcher().execute(
      renameCall(),
      ctxWith({
        policy: { approvalMode: "confirm" },
        confirm: async (req) => {
          requests.push(req);
          // Nothing may be written yet: the diff is the basis for this answer.
          expect(read("widget.ts")).toBe(WIDGET);
          return true;
        },
      }),
    );

    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.permission).toBe("write");
    expect(request.description).toContain("2 file(s)");
    expect(request.preview?.diff).toContain("-export class Widget {}");
    expect(request.preview?.diff).toContain("+export class Panel {}");
    // Both files are in the one reviewed patch.
    expect(request.preview?.diff).toContain("+++ b/uses.ts");
    expect(request.hunks?.map((h) => h.preview)).toEqual(["uses.ts (3 edit(s))", "widget.ts (2 edit(s))"]);
  });

  it("writes only the files the reviewer kept, and names the ones it skipped", async () => {
    setFixture({ rename: renameBothFiles() });
    const res = await createDefaultDispatcher().execute(
      renameCall(),
      ctxWith({
        policy: { approvalMode: "confirm" },
        // Hunks are ordered by path: 0 = uses.ts, 1 = widget.ts.
        confirm: async (): Promise<ConfirmResult> => ({ allow: true, selectedHunks: [1] }),
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ filesChanged: 1, skipped: ["uses.ts"] });
    expect(read("widget.ts")).toContain("class Panel");
    expect(read("uses.ts")).toBe(USES);
  });

  it("writes nothing when the reviewer declines", async () => {
    setFixture({ rename: renameBothFiles() });
    const res = await createDefaultDispatcher().execute(
      renameCall(),
      ctxWith({ policy: { approvalMode: "confirm" }, confirm: async () => false }),
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(read("widget.ts")).toBe(WIDGET);
    expect(read("uses.ts")).toBe(USES);
  });
});

describe("lsp_rename refuses rather than half-applying", () => {
  it("aborts when the edit reaches outside the workspace, without prompting", async () => {
    const outside = path.join(root, "outside.ts");
    fs.writeFileSync(outside, "export const Widget = 1;\n");
    setFixture({
      rename: {
        changes: {
          [uri("widget.ts")]: [edit(0, 13, 6, "Panel")],
          [pathToFileURL(outside).href]: [edit(0, 13, 6, "Panel")],
        },
      },
    });
    const requests: PermissionRequest[] = [];
    const res = await createDefaultDispatcher().execute(
      renameCall(),
      ctxWith({
        policy: { approvalMode: "confirm" },
        confirm: async (req) => {
          requests.push(req);
          return true;
        },
      }),
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_workspace");
    // The failure is known before the prompt, so the user is never asked to
    // approve a write that could not have happened.
    expect(requests).toHaveLength(0);
    expect(read("widget.ts")).toBe(WIDGET);
    expect(fs.readFileSync(outside, "utf8")).toBe("export const Widget = 1;\n");
  });

  it("refuses a server that wants to create, rename or delete files", async () => {
    setFixture({
      rename: {
        documentChanges: [
          { textDocument: { uri: uri("widget.ts"), version: 1 }, edits: [edit(0, 13, 6, "Panel")] },
          { kind: "rename", oldUri: uri("widget.ts"), newUri: uri("panel.ts") },
        ],
      },
    });
    const res = await createDefaultDispatcher().execute(renameCall(), ctxWith());

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unsupported_edit");
    expect(res.error?.message).toContain("rename");
    expect(read("widget.ts")).toBe(WIDGET);
  });

  it("detects a file that changed between the review and the write", async () => {
    setFixture({ rename: renameBothFiles() });
    const res = await createDefaultDispatcher().execute(
      renameCall(),
      ctxWith({
        policy: { approvalMode: "confirm" },
        confirm: async () => {
          // Someone edits the file while the prompt is on screen.
          fs.writeFileSync(path.join(workspace, "uses.ts"), "// rewritten\n");
          return true;
        },
      }),
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("stale_edit");
    // widget.ts was written first and then rolled back, so the workspace is
    // exactly as it was before the rename.
    expect(read("widget.ts")).toBe(WIDGET);
    expect(read("uses.ts")).toBe("// rewritten\n");
  });

  it("reports no_changes instead of pretending to rename nothing", async () => {
    setFixture({ rename: { changes: {} } });
    const res = await createDefaultDispatcher().execute(renameCall(), ctxWith());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("no_changes");
  });

  it("surfaces a server that rejects the new name", async () => {
    setFixture({ renameError: "newName is not a valid identifier" });
    const res = await createDefaultDispatcher().execute(renameCall(), ctxWith());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("lsp_error");
    expect(res.error?.message).toContain("valid identifier");
  });

  it("refuses to write into a symlink that points out of the workspace", async () => {
    const outside = path.join(root, "escape.ts");
    fs.writeFileSync(outside, "export class Widget {}\n");
    fs.symlinkSync(outside, path.join(workspace, "link.ts"));
    setFixture({ rename: { changes: { [uri("link.ts")]: [edit(0, 13, 6, "Panel")] } } });

    const res = await createDefaultDispatcher().execute(renameCall(), ctxWith());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_workspace");
    expect(fs.readFileSync(outside, "utf8")).toBe("export class Widget {}\n");
  });
});

describe("lsp_symbols", () => {
  it("returns each symbol's kind and workspace-relative position", async () => {
    setFixture({
      rename: renameBothFiles(),
      symbols: [
        {
          name: "Widget",
          kind: 5,
          containerName: "widget",
          location: {
            uri: uri("widget.ts"),
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
          },
        },
        {
          name: "make",
          kind: 12,
          location: {
            uri: uri("widget.ts"),
            range: { start: { line: 1, character: 13 }, end: { line: 1, character: 17 } },
          },
        },
      ],
    });

    const res = await createDefaultDispatcher().execute(
      call("lsp_symbols", { query: "Widget", path: "widget.ts" }),
      ctxWith(),
    );

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.data).toMatchObject({
      count: 2,
      symbols: [
        { name: "Widget", kind: "class", path: "widget.ts", line: 1, character: 13, container: "widget" },
        { name: "make", kind: "function", path: "widget.ts", line: 2 },
      ],
    });
  });

  it("reports the cap when the server returns more than asked for", async () => {
    setFixture({
      symbols: Array.from({ length: 5 }, (_, i) => ({
        name: `Widget${i}`,
        kind: 5,
        location: {
          uri: uri("widget.ts"),
          range: { start: { line: i, character: 0 }, end: { line: i, character: 6 } },
        },
      })),
    });

    const res = await createDefaultDispatcher().execute(
      call("lsp_symbols", { query: "Widget", path: "widget.ts", limit: 2 }),
      ctxWith(),
    );
    expect(res.data).toMatchObject({ count: 2, truncated: true, totalFound: 5 });
  });

  it("says which argument is missing when no server is running yet", async () => {
    const res = await createDefaultDispatcher().execute(call("lsp_symbols", { query: "Widget" }), ctxWith());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("lsp_no_session");
    expect(res.error?.message).toContain("path");
  });

  it("uses the already-running server once one exists", async () => {
    setFixture({
      symbols: [
        {
          name: "Widget",
          kind: 5,
          location: {
            uri: uri("widget.ts"),
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
          },
        },
      ],
    });
    const dispatcher = createDefaultDispatcher();
    // Any earlier call starts the session for this language.
    await dispatcher.execute(call("lsp_diagnostics", { path: "widget.ts" }), ctxWith());

    const res = await dispatcher.execute(call("lsp_symbols", { query: "Widget" }), ctxWith());
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.data).toMatchObject({ count: 1 });
  });
});
