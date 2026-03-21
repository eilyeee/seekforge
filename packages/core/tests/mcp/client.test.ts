import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpClient, McpError } from "../../src/mcp/client.js";
import { writeFixtureServer } from "./fixture.js";

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
});
