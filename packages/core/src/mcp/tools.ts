import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../tools/errors.js";
import { redactSecrets } from "../tools/redact.js";
import { defineTool, type ToolSpec } from "../tools/registry.js";
import { truncateHeadTail } from "../tools/text.js";
import { createMcpClient, McpError, type McpClient } from "./client.js";
import type { McpPromptArgument, McpServerConfig, McpTool } from "./types.js";

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
    async run(args, ctx) {
      let text: string;
      try {
        text = await client.callTool(tool.name, args as Record<string, unknown>, ctx.signal);
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
 * contributes zero tools. Cancellation is propagated to the caller.
 */
export async function buildMcpToolSpecs(clients: McpClientEntry[], signal?: AbortSignal): Promise<ToolSpec[]> {
  const groups = await Promise.all(
    clients.map(async (entry): Promise<ToolSpec[]> => {
      try {
        const tools: unknown = await entry.client.listTools(signal);
        if (!Array.isArray(tools)) throw new TypeError("tools/list result.tools must be an array");
        const specs: ToolSpec[] = [];
        for (const value of tools) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
          const tool = value as Partial<McpTool>;
          if (typeof tool.name !== "string" || tool.name.length === 0) continue;
          specs.push(toToolSpec(entry, tool as McpTool));
        }
        return specs;
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`warning: MCP server "${entry.serverName}" unavailable: ${message}\n`);
        return [];
      }
    }),
  );
  return groups.flat();
}

/** One resource as surfaced to callers, tagged with its server name. */
export type McpResourceRef = { server: string; uri: string; name?: string };

/**
 * Lists the resources of every connected server (resources/list), tagged
 * with the server name. A server that fails or does not support resources
 * logs a warning and contributes zero entries; this function never throws.
 */
export async function listMcpResources(clients: McpClientEntry[]): Promise<McpResourceRef[]> {
  const refs: McpResourceRef[] = [];
  for (const entry of clients) {
    try {
      for (const r of await entry.client.listResources()) {
        refs.push({ server: entry.serverName, uri: r.uri, ...(r.name !== undefined ? { name: r.name } : {}) });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: MCP server "${entry.serverName}" resources unavailable: ${message}\n`);
    }
  }
  return refs;
}

/**
 * Reads one resource (resources/read) from the named server, flattened to
 * text and capped at RESOURCE_READ_MAX_CHARS (see client.ts). Throws
 * McpError("unknown_server") when no client of that name exists; server-side
 * failures propagate as McpError.
 */
export async function readMcpResource(
  server: string,
  uri: string,
  clients: McpClientEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const entry = clients.find((e) => e.serverName === server);
  if (!entry) throw new McpError("unknown_server", `no MCP server named "${server}" is connected`);
  return entry.client.readResource(uri, signal);
}

/** One prompt as surfaced to callers, tagged with its server name. */
export type McpPromptRef = {
  server: string;
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
};

/**
 * Lists the prompts of every connected server (prompts/list), tagged with the
 * server name. A server that fails or does not support prompts logs a warning
 * and contributes zero entries; this function never throws. Mirrors
 * listMcpResources.
 */
export async function listMcpPrompts(clients: McpClientEntry[]): Promise<McpPromptRef[]> {
  const refs: McpPromptRef[] = [];
  for (const entry of clients) {
    try {
      for (const p of await entry.client.listPrompts()) {
        refs.push({
          server: entry.serverName,
          name: p.name,
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: MCP server "${entry.serverName}" prompts unavailable: ${message}\n`);
    }
  }
  return refs;
}

/**
 * Gets one prompt (prompts/get) from the named server, with its messages
 * rendered to a single string and capped at RESOURCE_READ_MAX_CHARS (see
 * client.ts). Throws McpError("unknown_server") when no client of that name
 * exists; server-side failures propagate as McpError. Mirrors readMcpResource.
 */
export async function getMcpPrompt(
  server: string,
  name: string,
  args: Record<string, unknown> | undefined,
  clients: McpClientEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const entry = clients.find((e) => e.serverName === server);
  if (!entry) throw new McpError("unknown_server", `no MCP server named "${server}" is connected`);
  return entry.client.getPrompt(name, args, signal);
}

/**
 * Creates a client per configured server and builds their ToolSpecs.
 * `entries` exposes the live connections for resource access
 * (listMcpResources / readMcpResource). dispose() shuts every client down
 * (kills the child processes). `workspaceRoots` (absolute paths) is advertised
 * to each server via the roots capability and answered on roots/list.
 */
export async function loadMcpToolSpecs(
  servers: Record<string, McpServerConfig>,
  workspaceRoots?: string[],
  signal?: AbortSignal,
): Promise<{ specs: ToolSpec[]; entries: McpClientEntry[]; dispose: () => void }> {
  const entries: McpClientEntry[] = [];
  for (const [serverName, value] of Object.entries(servers)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      process.stderr.write(`warning: MCP server "${serverName}" has an invalid configuration\n`);
      continue;
    }
    const config = value as McpServerConfig;
    entries.push({
      serverName,
      client: createMcpClient({
        name: serverName,
        config,
        ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
      }),
      trusted: config.trusted === true,
    });
  }
  const dispose = () => {
    for (const entry of entries) entry.client.dispose();
  };
  try {
    const specs = await buildMcpToolSpecs(entries, signal);
    return { specs, entries, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
