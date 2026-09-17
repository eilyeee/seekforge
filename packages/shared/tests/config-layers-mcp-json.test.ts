// `.mcp.json` — Claude Code's project server file — read as a repository layer.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BaseConfigShape,
  mergeConfigLayersWithReport,
  PROJECT_MCP_JSON_FILE,
  readProjectMcpJsonLayer,
  repositoryConfigLayer,
  userConfigLayer,
} from "../src/config-layers.js";

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "sf-mcp-json-"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const write = (value: unknown): void => writeFileSync(join(project, PROJECT_MCP_JSON_FILE), JSON.stringify(value));

describe("readProjectMcpJsonLayer", () => {
  it("is a repository layer carrying only the format's server fields", () => {
    write({
      mcpServers: {
        fs: {
          type: "stdio",
          command: "npx",
          args: ["-y", "fs"],
          env: { K: "${K}" },
          trusted: true,
          permission: "readonly",
        },
        docs: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { A: "b" },
          oauth: { clientId: "x", callbackPort: 1 },
        },
        broken: "not an object",
      },
      model: "should-not-leak",
      permissionRules: [{ action: "allow", tool: "run_command" }],
    });
    const layer = readProjectMcpJsonLayer<BaseConfigShape>(project);
    expect(layer.origin).toBe("repository");
    expect(layer.config).toEqual({
      mcpServers: {
        fs: { type: "stdio", command: "npx", args: ["-y", "fs"], env: { K: "${K}" } },
        docs: { type: "http", url: "https://docs.example/mcp", headers: { A: "b" } },
      },
    });
  });

  it("yields an empty layer for a missing, malformed or server-less file", () => {
    expect(readProjectMcpJsonLayer(project).config).toEqual({});
    writeFileSync(join(project, PROJECT_MCP_JSON_FILE), "{ nope");
    expect(readProjectMcpJsonLayer(project).config).toEqual({});
    write([]);
    expect(readProjectMcpJsonLayer(project).config).toEqual({});
    write({ mcpServers: [] });
    expect(readProjectMcpJsonLayer(project).config).toEqual({});
  });

  it("cannot shadow a user server and loses to SeekForge's own project file", () => {
    write({
      mcpServers: { gh: { command: "evil" }, shared: { command: "from-mcp-json" }, only: { command: "mcp-json" } },
    });
    const { config, report } = mergeConfigLayersWithReport(
      [
        userConfigLayer({ mcpServers: { gh: { command: "gh-mcp", trusted: true } } }),
        readProjectMcpJsonLayer(project),
        repositoryConfigLayer({ mcpServers: { shared: { command: "from-seekforge" } } }),
      ],
      { envOverrides: false },
    );
    expect(config.mcpServers).toEqual({
      gh: { command: "gh-mcp", trusted: true },
      shared: { command: "from-seekforge" },
      only: { command: "mcp-json" },
    });
    expect(report.mcpShadowed).toEqual(["gh"]);
    expect(report.mcpServerOrigins).toEqual({ gh: "user", shared: "repository", only: "repository" });
  });

  it("keeps a server literally named __proto__ as data", () => {
    writeFileSync(join(project, PROJECT_MCP_JSON_FILE), '{"mcpServers":{"__proto__":{"command":"x"}}}');
    const servers = readProjectMcpJsonLayer(project).config.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
