import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../tools/errors.js";
import { redactSecrets } from "../tools/redact.js";
import { defineTool, type ToolSpec } from "../tools/registry.js";
import { truncateHeadTail } from "../tools/text.js";
import { createMcpClient, type McpClient } from "./client.js";
import type { McpServerConfig, McpTool } from "./types.js";

const DESCRIPTION_MAX_CHARS = 500;

export type McpClientEntry = {
  serverName: string;
  client: McpClient;
  trusted: boolean;
};

function truncateDescription(text: string): string {
  return text.length <= DESCRIPTION_MAX_CHARS ? text : text.slice(0, DESCRIPTION_MAX_CHARS);
}

function toToolSpec(entry: McpClientEntry, tool: McpTool): ToolSpec {
  const { serverName, client, trusted } = entry;
  return defineTool({
    name: `mcp__${serverName}__${tool.name}`,
    description: truncateDescription(`[MCP:${serverName}] ${tool.description ?? ""}`.trim()),
    // Validation stays permissive — the MCP server validates its own args.
    // The model sees the server's raw JSON Schema via parametersOverride.
    schema: z.object({}).passthrough(),
    parametersOverride: tool.inputSchema ?? { type: "object", properties: {} },
    classify: () => ({
      // Untrusted MCP servers run arbitrary code: "env" is always confirmed,
      // even with -y. Trusted servers run at "write" (auto with -y).
      permission: trusted ? "write" : "env",
      description: `Call MCP tool ${serverName}/${tool.name}`,
      command: `mcp:${serverName}/${tool.name}`,
    }),
    async run(args) {
      let text: string;
      try {
        text = await client.callTool(tool.name, args as Record<string, unknown>);
      } catch (err) {
        throw new ToolError("mcp_error", err instanceof Error ? err.message : String(err));
      }
      const { text: capped, truncated } = truncateHeadTail(text, DEFAULT_LIMITS.toolOutputMaxChars);
      return { data: { content: redactSecrets(capped) }, meta: { truncated } };
    },
  });
}

/**
 * Lists each server's tools and converts them to dispatcher ToolSpecs named
 * `mcp__<server>__<tool>`. A failing server logs a warning to stderr and
 * contributes zero tools; this function never throws.
 */
export async function buildMcpToolSpecs(clients: McpClientEntry[]): Promise<ToolSpec[]> {
  const specs: ToolSpec[] = [];
  for (const entry of clients) {
    let tools: McpTool[];
    try {
      tools = await entry.client.listTools();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: MCP server "${entry.serverName}" unavailable: ${message}\n`);
      continue;
    }
    for (const tool of tools) specs.push(toToolSpec(entry, tool));
  }
  return specs;
}

/**
 * Creates a client per configured server and builds their ToolSpecs.
 * dispose() shuts every client down (kills the child processes).
 */
export async function loadMcpToolSpecs(
  servers: Record<string, McpServerConfig>,
): Promise<{ specs: ToolSpec[]; dispose: () => void }> {
  const entries: McpClientEntry[] = Object.entries(servers).map(([serverName, config]) => ({
    serverName,
    client: createMcpClient({ name: serverName, config }),
    trusted: config.trusted ?? false,
  }));
  const specs = await buildMcpToolSpecs(entries);
  return {
    specs,
    dispose: () => {
      for (const e of entries) e.client.dispose();
    },
  };
}
