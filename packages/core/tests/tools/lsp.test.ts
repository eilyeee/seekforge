import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultDispatcher, disposeLspServers } from "../../src/tools/index.js";
import { lspTools } from "../../src/tools/builtins/lsp.js";
import {
  encodeLspMessage,
  parseLspMessages,
  MAX_CONTENT_LENGTH,
  commandExistsOnPath,
  resolveServerCommand,
  supportedLspExtensions,
  severityLabel,
} from "../../src/tools/lsp/client.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * No test here spawns a real language server (CI has none). Coverage is:
 *   1. PURE wire framing — encodeLspMessage/parseLspMessages: correct
 *      Content-Length framing, two concatenated messages, a partial message,
 *      and a malformed header block.
 *   2. the tools register with the expected schemas + permission levels, and
 *   3. graceful degradation — with no server binary on PATH, every tool returns
 *      an actionable `lsp_unavailable` install hint instead of crashing. We
 *      force absence by emptying PATH so the outcome is deterministic.
 */

const NAMES = [
  "lsp_definition",
  "lsp_references",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_code_actions",
  "lsp_apply_code_action",
  "lsp_format",
  "lsp_rename",
  "lsp_symbols",
  "lsp_call_hierarchy",
  "lsp_type_hierarchy",
];

describe("lsp wire framing (pure)", () => {
  it("frames a message with a byte-accurate Content-Length and round-trips", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { unicode: "café→λ" } };
    const encoded = encodeLspMessage(msg);
    const text = encoded.toString("utf8");
    expect(text.startsWith("Content-Length: ")).toBe(true);
    expect(text).toContain("\r\n\r\n");
    // Content-Length is the BYTE length of the JSON body, not its char length.
    const bodyBytes = Buffer.from(JSON.stringify(msg), "utf8").length;
    expect(text).toContain(`Content-Length: ${bodyBytes}\r\n\r\n`);

    const { messages, rest } = parseLspMessages(encoded);
    expect(messages).toEqual([msg]);
    expect(rest.length).toBe(0);
  });

  it("parses two concatenated messages out of one buffer", () => {
    const a = { jsonrpc: "2.0", id: 1, result: "a" };
    const b = { jsonrpc: "2.0", id: 2, result: "b" };
    const buf = Buffer.concat([encodeLspMessage(a), encodeLspMessage(b)]);
    const { messages, rest } = parseLspMessages(buf);
    expect(messages).toEqual([a, b]);
    expect(rest.length).toBe(0);
  });

  it("ignores valid JSON non-object frames and continues parsing", () => {
    const good = { jsonrpc: "2.0", id: 3, result: "ok" };
    const buf = Buffer.concat([...[null, 42, "text", []].map(encodeLspMessage), encodeLspMessage(good)]);
    expect(parseLspMessages(buf)).toEqual({ messages: [good], rest: Buffer.alloc(0) });
  });

  it("waits for more bytes on a partial body (leaves it in rest)", () => {
    const full = encodeLspMessage({ jsonrpc: "2.0", id: 7, result: { some: "payload" } });
    const partial = full.subarray(0, full.length - 5); // truncate the body
    const { messages, rest } = parseLspMessages(partial);
    expect(messages).toEqual([]);
    expect(rest.equals(partial)).toBe(true);
    // Feeding the remaining bytes completes the message.
    const completed = parseLspMessages(Buffer.concat([rest, full.subarray(full.length - 5)]));
    expect(completed.messages).toEqual([{ jsonrpc: "2.0", id: 7, result: { some: "payload" } }]);
    expect(completed.rest.length).toBe(0);
  });

  it("waits for more bytes when even the header is incomplete", () => {
    const partialHeader = Buffer.from("Content-Length: 40\r\n");
    const { messages, rest } = parseLspMessages(partialHeader);
    expect(messages).toEqual([]);
    expect(rest.equals(partialHeader)).toBe(true);
  });

  it("resyncs past a malformed header block and parses the next message", () => {
    const good = { jsonrpc: "2.0", id: 9, result: "ok" };
    const buf = Buffer.concat([Buffer.from("Garbage-Header: nope\r\n\r\n"), encodeLspMessage(good)]);
    const { messages, rest } = parseLspMessages(buf);
    expect(messages).toEqual([good]);
    expect(rest.length).toBe(0);
  });

  it("drops a frame with an absurd Content-Length instead of buffering forever", () => {
    const good = { jsonrpc: "2.0", id: 1, result: "ok" };
    const evil = Buffer.from(`Content-Length: ${MAX_CONTENT_LENGTH + 1}\r\n\r\n`, "ascii");
    // The oversized header is skipped (resync); the following valid message parses.
    const { messages, rest } = parseLspMessages(Buffer.concat([evil, encodeLspMessage(good)]));
    expect(messages).toEqual([good]);
    expect(rest.length).toBe(0);
  });
});

describe("lsp language → server resolution", () => {
  const savedPath = process.env.PATH;
  beforeEach(() => {
    // Force "no server on PATH" deterministically.
    process.env.PATH = "";
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("commandExistsOnPath is false with an empty PATH", () => {
    expect(commandExistsOnPath("typescript-language-server")).toBe(false);
  });

  it("throws lsp_unavailable with a named install hint for a known language", () => {
    expect(() => resolveServerCommand("/ws/src/app.ts")).toThrowError(/typescript-language-server/);
  });

  it("throws lsp_unsupported for an unknown extension", () => {
    try {
      resolveServerCommand("/ws/notes.txt");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("lsp_unsupported");
    }
  });

  it("names an install hint for every language it claims to support", () => {
    // Each entry promises a specific binary; a language added without one
    // degrades to a bare "unavailable" the user cannot act on.
    for (const file of [
      "a.rs",
      "a.c",
      "a.cpp",
      "a.rb",
      "a.php",
      "a.kt",
      "a.swift",
      "a.scala",
      "a.lua",
      "a.zig",
      "a.sh",
    ]) {
      try {
        resolveServerCommand(`/ws/${file}`);
        throw new Error(`expected throw for ${file}`);
      } catch (err) {
        // Not lsp_unsupported: the language IS configured, its server just is
        // not installed (PATH is empty in this block).
        expect((err as { code?: string }).code, file).toBe("lsp_unavailable");
        expect((err as { message?: string }).message, file).toMatch(/install|ships with/i);
      }
    }
  });

  it("lists the supported extensions in the unsupported error, from the table", () => {
    // The message used to be a hand-written "Supported: .ts/.tsx/.js/.jsx, .py,
    // .go" that was already wrong and would have gone on being wrong.
    try {
      resolveServerCommand("/ws/notes.txt");
      throw new Error("expected throw");
    } catch (err) {
      const message = (err as { message?: string }).message ?? "";
      for (const ext of [".ts", ".py", ".go", ".rs", ".swift"]) expect(message, ext).toContain(ext);
    }
  });

  it("serves every language the repo map outlines, or says why not", () => {
    // repo_map covers 19 languages; the lsp_* tools covered four, so a Rust
    // file could be mapped and then not renamed. These two surfaces are kept
    // aligned deliberately — the exceptions below are the whole allowed gap.
    const mapped = [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".go",
      ".rs",
      ".c",
      ".cc",
      ".cpp",
      ".rb",
      ".php",
      ".kt",
      ".swift",
      ".scala",
      ".lua",
      ".zig",
      ".sh",
    ];
    const served = new Set(supportedLspExtensions());
    expect(mapped.filter((ext) => !served.has(ext))).toEqual([]);
    // Java and C# are outlined but not served: jdtls wants a `-data <dir>`
    // workspace and OmniSharp wants a solution probe, neither of which this
    // seam can guess. Pinned so the omission stays a decision.
    expect(served.has(".java")).toBe(false);
    expect(served.has(".cs")).toBe(false);
  });

  it("labels diagnostic severities", () => {
    expect(severityLabel(1)).toBe("error");
    expect(severityLabel(2)).toBe("warning");
    expect(severityLabel(undefined)).toBe("info");
  });
});

describe("lsp tools registration", () => {
  it("exposes exactly the lsp tools", () => {
    expect(lspTools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("advertises all of them through the default dispatcher", () => {
    const defs = createDefaultDispatcher().list();
    for (const name of NAMES) {
      const def = defs.find((d) => d.name === name);
      expect(def).toBeDefined();
      expect(def?.parameters).toBeDefined();
    }
  });

  it("classifies the analysis tools as readonly, surfacing the path", () => {
    const cls = (name: string, args: Record<string, unknown>) =>
      lspTools.find((t) => t.name === name)!.classify(args as never, makeCtx(makeWorkspace()));
    expect(cls("lsp_definition", { path: "src/a.ts", line: 3 }).permission).toBe("readonly");
    expect(cls("lsp_references", { path: "src/a.ts", line: 3 }).permission).toBe("readonly");
    expect(cls("lsp_diagnostics", { path: "src/a.ts" }).permission).toBe("readonly");
    expect(cls("lsp_symbols", { query: "Widget" }).permission).toBe("readonly");
    expect(cls("lsp_hover", { path: "src/a.ts", line: 3 }).permission).toBe("readonly");
    expect(cls("lsp_document_symbols", { path: "src/a.ts" }).permission).toBe("readonly");
    expect(cls("lsp_code_actions", { path: "src/a.ts", line: 3 }).permission).toBe("readonly");
    expect(cls("lsp_definition", { path: "src/a.ts", line: 3 }).path).toBe("src/a.ts");
  });

  it("classifies the editing tools as writes on the file they touch", () => {
    const cls = (name: string, args: Record<string, unknown>) =>
      lspTools.find((t) => t.name === name)!.classify(args as never, makeCtx(makeWorkspace()));
    const action = cls("lsp_apply_code_action", { path: "src/a.ts", line: 3, title: "Add import" });
    expect(action.permission).toBe("write");
    expect(action.path).toBe("src/a.ts");
    expect(action.description).toContain("Add import");
    const format = cls("lsp_format", { path: "src/a.ts" });
    expect(format.permission).toBe("write");
    expect(format.path).toBe("src/a.ts");
  });

  it("classifies lsp_rename as a write on the anchor file", () => {
    const rename = lspTools.find((t) => t.name === "lsp_rename")!;
    const cls = rename.classify({ path: "src/a.ts", line: 3, newName: "widget" } as never, makeCtx(makeWorkspace()));
    expect(cls.permission).toBe("write");
    expect(cls.path).toBe("src/a.ts");
    expect(cls.description).toContain("widget");
  });
});

describe("lsp tools graceful degradation (no language server on PATH)", () => {
  const savedPath = process.env.PATH;
  beforeEach(() => {
    process.env.PATH = "";
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    await disposeLspServers();
  });

  it.each([
    ["lsp_definition", { path: "src/app.ts", line: 1 }],
    ["lsp_references", { path: "src/app.ts", line: 1 }],
    ["lsp_diagnostics", { path: "src/app.ts" }],
    ["lsp_rename", { path: "src/app.ts", line: 1, newName: "renamed" }],
    ["lsp_symbols", { query: "Widget", path: "src/app.ts" }],
    ["lsp_hover", { path: "src/app.ts", line: 1 }],
    ["lsp_document_symbols", { path: "src/app.ts" }],
    ["lsp_code_actions", { path: "src/app.ts", line: 1 }],
    ["lsp_apply_code_action", { path: "src/app.ts", line: 1, title: "Fix" }],
    ["lsp_format", { path: "src/app.ts" }],
  ])("%s reports lsp_unavailable with an install hint", async (name, args) => {
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(call(name, args), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("lsp_unavailable");
    expect(res.error?.message).toContain("typescript-language-server");
  });

  it("reports lsp_unsupported for a file type with no known server", async () => {
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(call("lsp_diagnostics", { path: "notes.txt" }), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("lsp_unsupported");
  });

  it("rejects invalid arguments before touching any server", async () => {
    const dispatcher = createDefaultDispatcher();
    // line must be >= 1
    const res = await dispatcher.execute(
      call("lsp_definition", { path: "src/app.ts", line: 0 }),
      makeCtx(makeWorkspace()),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });
});
