import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createMcpClient, type McpClient } from "../../src/mcp/client.js";
import {
  buildMcpToolSpecs,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  loadMcpToolSpecs,
  readMcpResource,
} from "../../src/mcp/tools.js";
import { createDefaultDispatcher, createDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "../tools/helpers.js";
import { writeFixtureServer } from "./fixture.js";

let serverPath: string;
let cleanup: () => void;
let workspace: string;
const clients: McpClient[] = [];

beforeAll(() => {
  ({ serverPath, cleanup } = writeFixtureServer());
  workspace = makeWorkspace();
});

afterAll(() => {
  cleanup();
});

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

function makeEntry(serverName: string, trusted: boolean) {
  const client = createMcpClient({
    name: serverName,
    config: { command: process.execPath, args: [serverPath] },
  });
  clients.push(client);
  return { serverName, client, trusted };
}

describe("buildMcpToolSpecs", () => {
  it("maps tools to namespaced specs with permission by trust level", async () => {
    const specs = await buildMcpToolSpecs([makeEntry("fake", false)]);
    expect(specs.map((s) => s.name)).toEqual(["mcp__fake__echo", "mcp__fake__boom"]);

    const echo = specs[0]!;
    expect(echo.description).toBe("[MCP:fake] Echoes arguments back.\nSecond line of docs.");
    const cls = echo.classify({}, makeCtx(workspace));
    expect(cls).toMatchObject({
      permission: "env", // untrusted: always confirmed, even with -y
      description: "Call MCP tool fake/echo",
      command: "mcp:fake/echo",
    });

    const trusted = await buildMcpToolSpecs([makeEntry("fake2", true)]);
    expect(trusted[0]!.classify({}, makeCtx(workspace)).permission).toBe("write");
  }, 20_000); // spawns MCP child processes — slow under parallel load

  it("exposes the server's raw inputSchema via dispatcher list()", async () => {
    const specs = await buildMcpToolSpecs([makeEntry("fake", false)]);
    const defs = createDispatcher(specs).list();
    const echo = defs.find((d) => d.name === "mcp__fake__echo");
    expect(echo?.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    // No inputSchema on the server side -> permissive empty object schema.
    const boom = defs.find((d) => d.name === "mcp__fake__boom");
    expect(boom?.parameters).toEqual({ type: "object", properties: {} });
  });

  it("contributes zero specs for a failing server, keeping the others", async () => {
    const broken = {
      serverName: "broken",
      client: createMcpClient({
        name: "broken",
        config: { command: "/nonexistent/seekforge-no-such-binary" },
      }),
      trusted: false,
    };
    clients.push(broken.client);
    const specs = await buildMcpToolSpecs([broken, makeEntry("fake", false)]);
    expect(specs.map((s) => s.name)).toEqual(["mcp__fake__echo", "mcp__fake__boom"]);
  });
});

describe("dispatch through createDefaultDispatcher", () => {
  it("asks for confirmation on untrusted tools even in auto approval mode", async () => {
    const specs = await buildMcpToolSpecs([makeEntry("fake", false)]);
    const dispatcher = createDefaultDispatcher(specs);
    const prompts: PermissionRequest[] = [];
    const ctx = makeCtx(workspace, {
      policy: { approvalMode: "auto" }, // -y semantics
      confirm: async (req) => {
        prompts.push(req);
        return true;
      },
    });

    const res = await dispatcher.execute(call("mcp__fake__echo", { text: "hi" }), ctx);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ content: 'echo:{"text":"hi"}\n[image content]' });
    // approvalMode "auto": "env" still confirms — exactly one prompt.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      toolName: "mcp__fake__echo",
      permission: "env",
      command: "mcp:fake/echo",
    });
  });

  it("denies untrusted tools when the user refuses", async () => {
    const specs = await buildMcpToolSpecs([makeEntry("fake", false)]);
    const dispatcher = createDefaultDispatcher(specs);
    const ctx = makeCtx(workspace, {
      policy: { approvalMode: "auto" },
      confirm: async () => false,
    });
    const res = await dispatcher.execute(call("mcp__fake__echo", { text: "no" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
  });

  it("runs trusted tools without prompting under auto approval", async () => {
    const specs = await buildMcpToolSpecs([makeEntry("fake", true)]);
    const dispatcher = createDefaultDispatcher(specs);
    let prompted = 0;
    const ctx = makeCtx(workspace, {
      policy: { approvalMode: "auto" },
      confirm: async () => {
        prompted++;
        return true;
      },
    });
    const res = await dispatcher.execute(call("mcp__fake__echo", { text: "go" }), ctx);
    expect(res.ok).toBe(true);
    expect(prompted).toBe(0); // "write" auto-approves with -y
    expect(res.meta?.permission).toBe("write");
  });

  it("maps isError tool results to a mcp_error failure", async () => {
    const specs = await buildMcpToolSpecs([makeEntry("fake", true)]);
    const dispatcher = createDefaultDispatcher(specs);
    const ctx = makeCtx(workspace, { policy: { approvalMode: "auto" } });
    const res = await dispatcher.execute(call("mcp__fake__boom", {}), ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "mcp_error", message: "kaboom" });
  });
});

describe("loadMcpToolSpecs", () => {
  it("builds specs from a config record and disposes all clients", async () => {
    const { specs, dispose } = await loadMcpToolSpecs({
      fake: { command: process.execPath, args: [serverPath] },
      broken: { command: "/nonexistent/seekforge-no-such-binary", trusted: true },
    });
    try {
      expect(specs.map((s) => s.name)).toEqual(["mcp__fake__echo", "mcp__fake__boom"]);
    } finally {
      dispose();
    }
  });

  it("exposes the live connections for resource access via entries", async () => {
    const { entries, dispose } = await loadMcpToolSpecs({
      fake: { command: process.execPath, args: [serverPath] },
    });
    try {
      expect(entries.map((e) => e.serverName)).toEqual(["fake"]);
      const refs = await listMcpResources(entries);
      expect(refs).toEqual([
        { server: "fake", uri: "mem://notes", name: "Notes" },
        { server: "fake", uri: "mem://logo" },
      ]);
      expect(await readMcpResource("fake", "mem://notes", entries)).toBe("note one\nnote two");
    } finally {
      dispose();
    }
  });
});

describe("mcp resources", () => {
  it("listMcpResources skips a failing server but keeps the others", async () => {
    const broken = {
      serverName: "broken",
      client: createMcpClient({
        name: "broken",
        config: { command: "/nonexistent/seekforge-no-such-binary" },
      }),
      trusted: false,
    };
    clients.push(broken.client);
    const refs = await listMcpResources([broken, makeEntry("fake", false)]);
    expect(refs.map((r) => r.uri)).toEqual(["mem://notes", "mem://logo"]);
    expect(refs.every((r) => r.server === "fake")).toBe(true);
  });

  it("readMcpResource rejects an unknown server name", async () => {
    await expect(readMcpResource("nope", "mem://notes", [makeEntry("fake", false)])).rejects.toMatchObject({
      name: "McpError",
      code: "unknown_server",
    });
  });
});

describe("mcp prompts", () => {
  it("listMcpPrompts aggregates prompts across servers, tagging each with its server", async () => {
    const refs = await listMcpPrompts([makeEntry("a", false), makeEntry("b", true)]);
    expect(refs).toEqual([
      {
        server: "a",
        name: "greet",
        description: "Greets someone.",
        arguments: [{ name: "name", description: "Who to greet", required: true }],
      },
      { server: "a", name: "review", description: "Reviews code." },
      {
        server: "b",
        name: "greet",
        description: "Greets someone.",
        arguments: [{ name: "name", description: "Who to greet", required: true }],
      },
      { server: "b", name: "review", description: "Reviews code." },
    ]);
  });

  it("listMcpPrompts skips a failing server but keeps the others", async () => {
    const broken = {
      serverName: "broken",
      client: createMcpClient({
        name: "broken",
        config: { command: "/nonexistent/seekforge-no-such-binary" },
      }),
      trusted: false,
    };
    clients.push(broken.client);
    const refs = await listMcpPrompts([broken, makeEntry("fake", false)]);
    expect(refs.map((r) => r.name)).toEqual(["greet", "review"]);
    expect(refs.every((r) => r.server === "fake")).toBe(true);
  });

  it("getMcpPrompt renders the prompt messages to a string", async () => {
    const entries = [makeEntry("fake", false)];
    expect(await getMcpPrompt("fake", "greet", { name: "Ada" }, entries)).toBe(
      "system: Be friendly.\n\nuser: Hello Ada",
    );
  });

  it("getMcpPrompt rejects an unknown server name", async () => {
    await expect(getMcpPrompt("nope", "greet", {}, [makeEntry("fake", false)])).rejects.toMatchObject({
      name: "McpError",
      code: "unknown_server",
    });
  });
});
