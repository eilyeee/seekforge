import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createMcpClient } from "../../src/mcp/client.js";
import {
  defaultMcpServerTrust,
  expandMcpEnvRefs,
  mcpChildEnv,
  mcpTransportOf,
  resolveMcpServerConfig,
} from "../../src/mcp/launch.js";
import { mcpAttachments, MCP_IMAGE_MAX_BYTES, MCP_IMAGES_MAX_PER_RESULT } from "../../src/mcp/tools.js";

describe("expandMcpEnvRefs", () => {
  const env = { HOST: "example.com", EMPTY: "", TOKEN: "t0k" };
  it("expands ${VAR} and ${VAR:-default} like a shell", () => {
    expect(expandMcpEnvRefs("https://${HOST}/mcp", env)).toBe("https://example.com/mcp");
    expect(expandMcpEnvRefs("${MISSING}", env)).toBe("");
    expect(expandMcpEnvRefs("${MISSING:-fallback}", env)).toBe("fallback");
    expect(expandMcpEnvRefs("${EMPTY:-fallback}", env)).toBe("fallback");
    expect(expandMcpEnvRefs("${HOST:-fallback}", env)).toBe("example.com");
    expect(expandMcpEnvRefs("${MISSING:-}", env)).toBe("");
    // The default is literal text, not another reference.
    expect(expandMcpEnvRefs("${MISSING:-${TOKEN}}", env)).toBe("${TOKEN}");
    // Not references: plain $VAR, invalid names, unterminated braces.
    expect(expandMcpEnvRefs("$TOKEN ${1X} ${TOKEN", env)).toBe("$TOKEN ${1X} ${TOKEN");
  });
});

describe("resolveMcpServerConfig", () => {
  const env = { BIN: "/opt/bin/server", ARG: "--fast", KEY: "k", HOST: "h.example" };
  const config = {
    command: "${BIN}",
    args: ["${ARG}", "--name=${MISSING:-anon}"],
    env: { API_KEY: "${KEY}" },
    url: "https://${HOST}/mcp",
    headers: { Authorization: "Bearer ${KEY}" },
    oauth: { tokenEndpoint: "https://${HOST}/token", clientId: "${KEY}", refreshToken: "r" },
  };

  it("expands command, args, env values, url, headers and oauth for user and approved project servers", () => {
    for (const trust of ["user", "project"] as const) {
      expect(resolveMcpServerConfig(config, trust, env)).toEqual({
        command: "/opt/bin/server",
        args: ["--fast", "--name=anon"],
        env: { API_KEY: "k" },
        url: "https://h.example/mcp",
        headers: { Authorization: "Bearer k" },
        oauth: { tokenEndpoint: "https://h.example/token", clientId: "k", refreshToken: "r" },
      });
    }
  });

  it("expands nothing for an unapproved definition and never mutates the input", () => {
    const before = JSON.stringify(config);
    expect(resolveMcpServerConfig(config, "untrusted", env)).toEqual(config);
    resolveMcpServerConfig(config, "user", env);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("defaults trust from the trusted flag only", () => {
    expect(defaultMcpServerTrust({ command: "x", trusted: true })).toBe("user");
    expect(defaultMcpServerTrust({ command: "x" })).toBe("untrusted");
    expect(defaultMcpServerTrust({ command: "x", trusted: false })).toBe("untrusted");
  });
});

describe("mcpChildEnv", () => {
  const source = { PATH: "/bin", GITHUB_TOKEN: "gh", OPENAI_API_KEY: "sk", HOME: "/home/u" };
  it("gives user servers the whole environment", () => {
    expect(mcpChildEnv({ command: "x", env: { EXTRA: "1" } }, "user", source)).toEqual({ ...source, EXTRA: "1" });
  });
  it("scrubs secret-looking variables for project and untrusted servers, except the ones the entry names", () => {
    for (const trust of ["project", "untrusted"] as const) {
      expect(mcpChildEnv({ command: "x", env: { GITHUB_TOKEN: "given" } }, trust, source)).toEqual({
        PATH: "/bin",
        HOME: "/home/u",
        GITHUB_TOKEN: "given",
      });
    }
  });
});

describe("mcpTransportOf", () => {
  it("prefers an explicit type and otherwise infers from url", () => {
    expect(mcpTransportOf({ command: "x" })).toBe("stdio");
    expect(mcpTransportOf({ url: "https://a" })).toBe("http");
    expect(mcpTransportOf({ type: "sse", url: "https://a" })).toBe("sse");
    expect(mcpTransportOf({ type: "stdio", command: "x", url: "https://a" })).toBe("stdio");
    expect(() => mcpTransportOf({ type: "ws" as never, url: "wss://a" })).toThrow(/unsupported MCP transport/);
  });

  it("a client for an unusable definition fails its requests instead of throwing on creation", async () => {
    const client = createMcpClient({ name: "bad", config: { type: "sse", command: "x" }, trust: "user" });
    await expect(client.listTools()).rejects.toMatchObject({ code: "mcp_config" });
    client.dispose();
  });
});

describe("HTTP references follow the trust", () => {
  async function headersFor(trust: "user" | "untrusted" | undefined, trusted?: boolean): Promise<IncomingHttpHeaders> {
    let seen: IncomingHttpHeaders | undefined;
    let path: string | undefined;
    const server = createServer((req, res) => {
      seen ??= req.headers;
      path ??= req.url;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.SEEKFORGE_TEST_HEADER_TOKEN = "leaked";
    process.env.SEEKFORGE_TEST_PATH = "secret-path";
    const client = createMcpClient({
      name: "h",
      config: {
        url: `http://127.0.0.1:${port}/\${SEEKFORGE_TEST_PATH}`,
        headers: { "x-token": "${SEEKFORGE_TEST_HEADER_TOKEN}" },
        ...(trusted !== undefined ? { trusted } : {}),
      },
      ...(trust !== undefined ? { trust } : {}),
    });
    try {
      await client.listTools().catch(() => {});
      return { ...seen, "x-path": path } as IncomingHttpHeaders;
    } finally {
      client.dispose();
      delete process.env.SEEKFORGE_TEST_HEADER_TOKEN;
      delete process.env.SEEKFORGE_TEST_PATH;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("expands url and headers for a user server", async () => {
    const seen = await headersFor("user");
    expect(seen["x-token"]).toBe("leaked");
    expect(seen["x-path"]).toBe("/secret-path");
  });

  it("sends the template literally for an unapproved server — explicit or defaulted", async () => {
    for (const seen of [await headersFor("untrusted"), await headersFor(undefined)]) {
      expect(seen["x-token"]).toBe("${SEEKFORGE_TEST_HEADER_TOKEN}");
      expect(seen["x-path"]).toBe("/$%7BSEEKFORGE_TEST_PATH%7D");
    }
  });

  it("a trusted entry defaults to user trust", async () => {
    expect((await headersFor(undefined, true))["x-token"]).toBe("leaked");
  });
});

describe("mcpAttachments", () => {
  const png = "iVBORw0KGgo=";
  it("attaches valid images up to the per-result limit and describes the rest", () => {
    const parts = Array.from({ length: MCP_IMAGES_MAX_PER_RESULT + 1 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: png,
    }));
    const { images, descriptors } = mcpAttachments(parts, "srv/tool");
    expect(images).toHaveLength(MCP_IMAGES_MAX_PER_RESULT);
    expect(descriptors.at(-1)).toMatchObject({ omitted: "too_many_images" });
  });

  it("refuses oversized, malformed and non-image payloads", () => {
    const oversized = "A".repeat(Math.ceil((MCP_IMAGE_MAX_BYTES + 3) / 3) * 4);
    const { images, descriptors } = mcpAttachments(
      [
        { type: "image", mimeType: "image/png", data: oversized },
        { type: "image", mimeType: "image/png", data: "not base64!" },
        { type: "image", mimeType: "image/svg+xml", data: png },
        { type: "image", mimeType: "IMAGE/JPEG", data: png },
        { type: "audio", mimeType: "audio/wav", data: png },
        { type: "resource", resource: { uri: "file:///x.png", mimeType: "image/png", blob: png } },
        { type: "resource", resource: { uri: "file:///x.bin", mimeType: "application/octet-stream", blob: png } },
      ],
      "l",
    );
    expect(images).toEqual([
      { mediaType: "image/jpeg", dataBase64: png, label: "l" },
      { mediaType: "image/png", dataBase64: png, label: "l" },
    ]);
    expect(descriptors.map((d) => d.omitted ?? d.attached ?? null)).toEqual([
      "too_large",
      "invalid_data",
      "unsupported_type",
      true,
      null,
      true,
      null,
    ]);
  });
});
