import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_LIMITS, PERMISSION_LEVEL, type PermissionName } from "@seekforge/shared";
import { ToolError } from "../tools/errors.js";
import { redactSecrets } from "../tools/redact.js";
import { defineTool, type ToolSpec } from "../tools/registry.js";
import { truncateHeadTail } from "../tools/text.js";
import { createMcpClient, McpError, type McpClient, type McpContentPart } from "./client.js";
import { sanitizeMcpErrorMessage } from "./errors.js";
import type { McpPromptArgument, McpServerConfig, McpTool } from "./types.js";

const DESCRIPTION_MAX_CHARS = 500;
const MCP_INPUT_SCHEMA_MAX_CHARS = 64 * 1024;
const MCP_RAW_TOOL_NAME_MAX_CHARS = 256;

export type McpClientEntry = {
  serverName: string;
  client: McpClient;
  trusted: boolean;
  permission?: PermissionName;
  toolPermissions?: Record<string, PermissionName>;
};

function isPermissionName(value: unknown): value is PermissionName {
  return typeof value === "string" && Object.hasOwn(PERMISSION_LEVEL, value);
}

function toolPermission(entry: McpClientEntry, tool: McpTool): PermissionName {
  if (!entry.trusted) return "env";
  const explicit = entry.toolPermissions?.[tool.name] ?? entry.permission;
  if (isPermissionName(explicit)) return explicit;
  if (tool.annotations?.destructiveHint === true || tool.annotations?.openWorldHint === true) return "env";
  if (tool.annotations?.readOnlyHint === true) return "readonly";
  return "write";
}

function truncateDescription(text: string): string {
  return text.length <= DESCRIPTION_MAX_CHARS ? text : text.slice(0, DESCRIPTION_MAX_CHARS);
}

function safeSegment(value: string, max: number): string {
  const normalized = value
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "tool").slice(0, max);
}

/** Preserves simple historical names; ambiguous/invalid/long names get a stable collision-resistant suffix. */
export function mcpToolPublicName(serverName: string, toolName: string): string {
  const simple = `mcp__${serverName}__${toolName}`;
  if (
    simple.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(simple) &&
    !serverName.includes("__") &&
    !toolName.includes("__")
  ) {
    return simple;
  }
  const digest = createHash("sha256").update(serverName).update("\0").update(toolName).digest("hex").slice(0, 10);
  return `mcp__${safeSegment(serverName, 15)}__${safeSegment(toolName, 25)}__${digest}`;
}

function inputSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > MCP_INPUT_SCHEMA_MAX_CHARS) {
    throw new RangeError(`MCP tool input schema exceeds ${MCP_INPUT_SCHEMA_MAX_CHARS} characters`);
  }
  return value as Record<string, unknown>;
}

function attachmentDescriptors(parts: readonly McpContentPart[]): Array<Record<string, unknown>> {
  return parts
    .filter((part) => part.type !== "text")
    .map((part) => {
      if (part.type === "resource") {
        return {
          type: "resource",
          ...(part.resource?.uri ? { uri: redactSecrets(part.resource.uri) } : {}),
          ...(part.resource?.mimeType ? { mimeType: part.resource.mimeType } : {}),
          ...(part.resource?.text ? { textChars: part.resource.text.length } : {}),
          ...(part.resource?.blob ? { encodedBytes: part.resource.blob.length } : {}),
        };
      }
      return {
        type: part.type,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.data ? { encodedBytes: part.data.length } : {}),
      };
    });
}

function safeStructuredContent(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = redactSecrets(JSON.stringify(value));
    if (serialized.length > DEFAULT_LIMITS.toolOutputMaxChars) {
      return `[structured content omitted: ${serialized.length} characters]`;
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    return "[unserializable structured content]";
  }
}

function toToolSpec(entry: McpClientEntry, tool: McpTool): ToolSpec {
  const { serverName, client } = entry;
  return defineTool({
    name: mcpToolPublicName(serverName, tool.name),
    description: truncateDescription(`[MCP:${serverName}] ${tool.description ?? ""}`.trim()),
    // Validation stays permissive — the MCP server validates its own args.
    // The model sees the server's raw JSON Schema via parametersOverride.
    schema: z.object({}).passthrough(),
    parametersOverride: inputSchema(tool.inputSchema),
    classify: () => ({
      // Untrusted MCP servers run arbitrary code: "env" is always confirmed,
      // even with -y. Trusted servers run at "write" (auto with -y).
      permission: toolPermission(entry, tool),
      description: `Call MCP tool ${serverName}/${tool.name}`,
      command: `mcp:${serverName}/${tool.name}`,
    }),
    async run(args, ctx) {
      let text: string;
      let attachments: Array<Record<string, unknown>> = [];
      let structuredContent: unknown;
      try {
        if (typeof client.callToolDetailed === "function") {
          const detailed = await client.callToolDetailed(tool.name, args as Record<string, unknown>, ctx.signal);
          text = detailed.text;
          attachments = attachmentDescriptors(detailed.content);
          structuredContent = safeStructuredContent(detailed.structuredContent);
        } else {
          text = await client.callTool(tool.name, args as Record<string, unknown>, ctx.signal);
        }
      } catch (err) {
        throw new ToolError("mcp_error", sanitizeMcpErrorMessage(err));
      }
      const { text: capped, truncated } = truncateHeadTail(text, DEFAULT_LIMITS.toolOutputMaxChars);
      return {
        data: {
          content: redactSecrets(capped),
          ...(structuredContent !== undefined ? { structuredContent } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        meta: { truncated },
      };
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
        const rawNames = new Set<string>();
        for (const value of tools) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
          const tool = value as Partial<McpTool>;
          if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MCP_RAW_TOOL_NAME_MAX_CHARS)
            continue;
          if (rawNames.has(tool.name))
            throw new TypeError(`tools/list repeated tool name ${JSON.stringify(tool.name)}`);
          rawNames.add(tool.name);
          specs.push(toToolSpec(entry, tool as McpTool));
        }
        return specs;
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = sanitizeMcpErrorMessage(err);
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
export async function listMcpResources(clients: McpClientEntry[], signal?: AbortSignal): Promise<McpResourceRef[]> {
  const groups = await Promise.all(
    clients.map(async (entry): Promise<McpResourceRef[]> => {
      const refs: McpResourceRef[] = [];
      try {
        for (const r of await entry.client.listResources(signal)) {
          refs.push({ server: entry.serverName, uri: r.uri, ...(r.name !== undefined ? { name: r.name } : {}) });
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = sanitizeMcpErrorMessage(err);
        process.stderr.write(`warning: MCP server "${entry.serverName}" resources unavailable: ${message}\n`);
      }
      return refs;
    }),
  );
  return groups.flat();
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
export async function listMcpPrompts(clients: McpClientEntry[], signal?: AbortSignal): Promise<McpPromptRef[]> {
  const groups = await Promise.all(
    clients.map(async (entry): Promise<McpPromptRef[]> => {
      const refs: McpPromptRef[] = [];
      try {
        for (const p of await entry.client.listPrompts(signal)) {
          refs.push({
            server: entry.serverName,
            name: p.name,
            ...(p.description !== undefined ? { description: p.description } : {}),
            ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
          });
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = sanitizeMcpErrorMessage(err);
        process.stderr.write(`warning: MCP server "${entry.serverName}" prompts unavailable: ${message}\n`);
      }
      return refs;
    }),
  );
  return groups.flat();
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
    // Discovery itself starts a local process or contacts a remote endpoint.
    // Tool-level confirmation happens too late to authorize that side effect.
    if (config.trusted !== true) continue;
    if (config.permission !== undefined && !isPermissionName(config.permission)) {
      process.stderr.write(`warning: MCP server "${serverName}" has an invalid permission\n`);
      continue;
    }
    if (
      config.toolPermissions !== undefined &&
      (typeof config.toolPermissions !== "object" ||
        config.toolPermissions === null ||
        Array.isArray(config.toolPermissions) ||
        Object.values(config.toolPermissions).some((permission) => !isPermissionName(permission)))
    ) {
      process.stderr.write(`warning: MCP server "${serverName}" has invalid toolPermissions\n`);
      continue;
    }
    entries.push({
      serverName,
      client: createMcpClient({
        name: serverName,
        config,
        ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
      }),
      trusted: true,
      ...(config.permission ? { permission: config.permission } : {}),
      ...(config.toolPermissions ? { toolPermissions: config.toolPermissions } : {}),
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
