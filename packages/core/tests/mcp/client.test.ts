import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpClient, McpError } from "../../src/mcp/client.js";
import { writeFallbackServer, writeFixtureServer } from "./fixture.js";

let serverPath: string;
let cleanup: () => void;

beforeAll(() => {
  ({ serverPath, cleanup } = writeFixtureServer());
});

afterAll(() => {
  cleanup();
});

function makeClient(timeoutMs?: number) {
  return createMcpClient({
    name: "fake",
    config: { command: process.execPath, args: [serverPath] },
    requestTimeoutMs: timeoutMs,
  });
}

describe("mcp client", () => {
  it("handshakes before the first call and lists tools", async () => {
    // The fixture answers any pre-handshake request with "not initialized",
    // so a successful tools/list proves initialize → initialized → call order.
    const client = makeClient();
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
      expect(tools[0]?.inputSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
      });
    } finally {
      client.dispose();
    }
  });

  it("shares one handshake across concurrent first calls", async () => {
    // The fixture exits with code 9 if it receives initialize twice.
    const client = makeClient();
    try {
      const [a, b] = await Promise.all([client.listTools(), client.listTools()]);
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(2);
    } finally {
      client.dispose();
    }
  });

  it("calls a tool and flattens content to text", async () => {
    const client = makeClient();
    try {
      const text = await client.callTool("echo", { text: "hi", n: 1 });
      expect(text).toBe('echo:{"text":"hi","n":1}\n[image content]');
    } finally {
      client.dispose();
    }
  });

  it("rejects isError results with the flattened text as the message", async () => {
    const client = makeClient();
    try {
      await expect(client.callTool("boom", {})).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_tool_error",
        message: "kaboom",
      });
    } finally {
      client.dispose();
    }
  });

  it("rejects pending calls on crash, then respawns and re-handshakes", async () => {
    const client = makeClient();
    try {
      await client.listTools(); // handshake done on the first process
      await expect(client.callTool("die", {})).rejects.toMatchObject({
        code: "mcp_crashed",
      });
      // Next call must respawn AND redo the handshake (the new process would
      // answer "not initialized" otherwise).
      const text = await client.callTool("echo", { text: "again" });
      expect(text).toContain('echo:{"text":"again"}');
    } finally {
      client.dispose();
    }
  }, 20_000); // spawns + respawns a child process — slow under parallel load

  it("lists resources via resources/list", async () => {
    const client = makeClient();
    try {
      const resources = await client.listResources();
      expect(resources).toEqual([
        { uri: "mem://notes", name: "Notes", mimeType: "text/plain" },
        { uri: "mem://logo" },
      ]);
    } finally {
      client.dispose();
    }
  });

  it("reads a text resource and flattens it; blobs become a placeholder", async () => {
    const client = makeClient();
    try {
      expect(await client.readResource("mem://notes")).toBe("note one\nnote two");
      expect(await client.readResource("mem://logo")).toBe("[binary content: image/png]");
    } finally {
      client.dispose();
    }
  });

  it("caps a read resource at 50_000 chars", async () => {
    const client = makeClient();
    try {
      const text = await client.readResource("mem://big");
      expect(text.length).toBeLessThanOrEqual(50_000 + "…[truncated]".length);
      expect(text.endsWith("…[truncated]")).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("propagates server errors for unknown resources", async () => {
    const client = makeClient();
    try {
      await expect(client.readResource("mem://nope")).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_error",
      });
    } finally {
      client.dispose();
    }
  });

  it("lists prompts via prompts/list", async () => {
    const client = makeClient();
    try {
      const prompts = await client.listPrompts();
      expect(prompts).toEqual([
        {
          name: "greet",
          description: "Greets someone.",
          arguments: [{ name: "name", description: "Who to greet", required: true }],
        },
        { name: "review", description: "Reviews code." },
      ]);
    } finally {
      client.dispose();
    }
  });

  it("gets a prompt and renders messages to a single string", async () => {
    const client = makeClient();
    try {
      expect(await client.getPrompt("greet", { name: "Ada" })).toBe(
        "system: Be friendly.\n\nuser: Hello Ada",
      );
    } finally {
      client.dispose();
    }
  });

  it("caps a rendered prompt at 50_000 chars", async () => {
    const client = makeClient();
    try {
      const text = await client.getPrompt("big");
      expect(text.length).toBeLessThanOrEqual(50_000 + "…[truncated]".length);
      expect(text.endsWith("…[truncated]")).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("propagates server errors for unknown prompts", async () => {
    const client = makeClient();
    try {
      await expect(client.getPrompt("nope")).rejects.toMatchObject({
        name: "McpError",
        code: "mcp_error",
      });
    } finally {
      client.dispose();
    }
  });

  it("advertises protocol 2025-06-18 + roots capability and answers roots/list with the workspace file:// URI", async () => {
    const root = "/tmp/seekforge-workspace";
    const client = createMcpClient({
      name: "fake",
      config: { command: process.execPath, args: [serverPath] },
      workspaceRoots: [root],
    });
    try {
      // The fixture captures the client's initialize payload and its answer to
      // the server-initiated roots/list, surfaced via the __getRoots tool.
      const raw = await client.callTool("__getRoots", {});
      const seen = JSON.parse(raw) as {
        protocolVersion: string;
        capabilities: { roots?: { listChanged?: boolean } };
        rootsAnswer: { roots?: Array<{ uri: string; name?: string }> };
      };
      expect(seen.protocolVersion).toBe("2025-06-18");
      expect(seen.capabilities.roots).toEqual({ listChanged: true });
      expect(seen.rootsAnswer.roots).toEqual([
        { uri: `file://${root}`, name: "workspace" },
      ]);
    } finally {
      client.dispose();
    }
  });

  it("reports an empty roots list when no workspace is configured", async () => {
    const client = makeClient();
    try {
      const raw = await client.callTool("__getRoots", {});
      const seen = JSON.parse(raw) as { rootsAnswer: { roots?: unknown[] } };
      expect(seen.rootsAnswer.roots).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("surfaces launch failures as errors", async () => {
    const client = createMcpClient({
      name: "missing",
      config: { command: "/nonexistent/seekforge-no-such-binary" },
    });
    try {
      await expect(client.listTools()).rejects.toBeInstanceOf(McpError);
    } finally {
      client.dispose();
    }
  });

  it("refuses calls after dispose", async () => {
    const client = makeClient();
    client.dispose();
    await expect(client.listTools()).rejects.toMatchObject({ code: "disposed" });
  });

  it("still connects when the server only speaks an older protocol revision", async () => {
    const old = writeFallbackServer();
    const client = createMcpClient({
      name: "old",
      config: { command: process.execPath, args: [old.serverPath] },
    });
    try {
      // The server replies with 2024-11-05; the client accepts it and proceeds.
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
    } finally {
      client.dispose();
      old.cleanup();
    }
  });
});
