import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory } from "./helpers.js";

const TOKEN = "test-token-mcp-settings";

let workspace: string;
let home: string;
let previousHome: string | undefined;
let server: RunningServer;
let base: string;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function save(body: Record<string, unknown>): Promise<Response> {
  return request("/api/mcp", { method: "POST", body: JSON.stringify(body) });
}

beforeAll(async () => {
  workspace = makeWorkspace();
  home = makeWorkspace();
  previousHome = process.env["HOME"];
  process.env["HOME"] = home;
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
});

describe("MCP settings scopes and secret preservation", () => {
  it("reads, writes, shadows, and deletes the requested config layer", async () => {
    const global = await save({
      name: "shared",
      scope: "global",
      command: "node",
      args: ["global-server.js"],
      env: { GLOBAL_TOKEN: "global-secret" },
    });
    expect(global.status).toBe(200);

    const project = await save({
      name: "shared",
      scope: "project",
      url: "https://mcp.example.test/rpc",
      headers: { Authorization: "Bearer header-secret" },
      env: { TENANT: "project-secret" },
      oauth: {
        tokenEndpoint: "https://auth.example.test/token",
        clientId: "desktop-client",
        clientSecret: "client-secret",
        refreshToken: "refresh-secret",
        scope: "mcp.read mcp.write",
      },
      trusted: true,
    });
    expect(project.status).toBe(200);
    const projectText = await project.text();
    expect(projectText).not.toContain("header-secret");
    expect(projectText).not.toContain("project-secret");
    expect(projectText).not.toContain("client-secret");
    expect(projectText).not.toContain("refresh-secret");

    const list = await request("/api/mcp");
    const listText = await list.text();
    expect(listText).not.toContain("global-secret");
    expect(listText).not.toContain("header-secret");
    expect(listText).not.toContain("refresh-secret");
    const servers = JSON.parse(listText) as Array<Record<string, unknown>>;
    expect(servers).toEqual([
      expect.objectContaining({
        name: "shared",
        transport: "http",
        source: "project",
        shadowedGlobal: true,
        headers: { Authorization: "********" },
        env: { TENANT: "********" },
        oauth: {
          tokenEndpoint: "https://auth.example.test/token",
          clientId: "desktop-client",
          clientSecret: "********",
          refreshToken: "********",
          scope: "mcp.read mcp.write",
        },
      }),
    ]);

    const removed = await request("/api/mcp/shared?scope=project", { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true, scope: "project" });
    const fallback = await (await request("/api/mcp")).json() as Array<Record<string, unknown>>;
    expect(fallback).toEqual([
      expect.objectContaining({ name: "shared", transport: "stdio", source: "global", shadowedGlobal: false }),
    ]);
  });

  it("retains masked header, env, and OAuth values without echoing plaintext", async () => {
    expect((await save({
      name: "oauth-http",
      scope: "project",
      url: "https://old.example.test/rpc",
      headers: { Authorization: "old-header", "X-New": "old-x" },
      env: { API_TOKEN: "old-env" },
      oauth: {
        tokenEndpoint: "https://auth.example.test/token",
        clientId: "client-one",
        clientSecret: "old-client-secret",
        refreshToken: "old-refresh-token",
      },
    })).status).toBe(200);

    const updated = await save({
      name: "oauth-http",
      scope: "project",
      url: "https://new.example.test/rpc",
      headers: { Authorization: "********", "X-New": "replacement-x" },
      env: { API_TOKEN: "********" },
      oauth: {
        tokenEndpoint: "https://auth.example.test/v2/token",
        clientId: "client-two",
        clientSecret: "********",
        refreshToken: "********",
        scope: "mcp.read",
      },
    });
    expect(updated.status).toBe(200);
    const responseText = await updated.text();
    for (const secret of ["old-header", "old-env", "old-client-secret", "old-refresh-token", "replacement-x"]) {
      expect(responseText).not.toContain(secret);
    }

    const config = JSON.parse(readFileSync(join(workspace, ".seekforge", "config.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(config.mcpServers["oauth-http"]).toMatchObject({
      url: "https://new.example.test/rpc",
      headers: { Authorization: "old-header", "X-New": "replacement-x" },
      env: { API_TOKEN: "old-env" },
      oauth: {
        tokenEndpoint: "https://auth.example.test/v2/token",
        clientId: "client-two",
        clientSecret: "old-client-secret",
        refreshToken: "old-refresh-token",
        scope: "mcp.read",
      },
    });
  });

  it("rejects masked OAuth placeholders when there is no value to preserve", async () => {
    const res = await save({
      name: "new-masked",
      scope: "project",
      url: "https://mcp.example.test/rpc",
      oauth: {
        tokenEndpoint: "https://auth.example.test/token",
        clientId: "client",
        refreshToken: "********",
      },
    });
    expect(res.status).toBe(400);
  });
});
