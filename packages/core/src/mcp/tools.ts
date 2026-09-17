import { createHash } from "node:crypto";
import { z } from "zod";
import { type ChatImage, DEFAULT_LIMITS, PERMISSION_LEVEL, type PermissionName } from "@seekforge/shared";
import { ToolError } from "../tools/errors.js";
import { redactSecrets } from "../tools/redact.js";
import { defineTool, type ToolSpec } from "../tools/registry.js";
import { truncateHeadTail } from "../tools/text.js";
import { McpError, type McpClient, type McpContentPart } from "./client.js";
import { sanitizeMcpErrorMessage } from "./errors.js";
import type { McpPromptArgument, McpServerTrust, McpTool } from "./types.js";

const DESCRIPTION_MAX_CHARS = 500;
const MCP_INPUT_SCHEMA_MAX_CHARS = 64 * 1024;
const MCP_RAW_TOOL_NAME_MAX_CHARS = 256;

export type McpClientEntry = {
  serverName: string;
  /**
   * The live connection. A registry reconnect replaces it in place, so tool
   * specs read it at call time rather than capturing it.
   */
  client: McpClient;
  trusted: boolean;
  /** Who stands behind the definition (see launch.ts). Absent on hand-built entries. */
  trust?: McpServerTrust;
  permission?: PermissionName;
  toolPermissions?: Record<string, PermissionName>;
};

export function isPermissionName(value: unknown): value is PermissionName {
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

/**
 * What an MCP image may cost the conversation. It is written into the session
 * transcript and resent on later turns until micro-compaction clears it, so the
 * per-image bound matches the browser screenshot attachment (1 MiB decoded),
 * well inside what the transcript accepts on replay (6 MiB of base64, 8 images
 * per message — see trace.ts).
 */
export const MCP_IMAGE_MAX_BYTES = 1024 * 1024;
export const MCP_IMAGES_MAX_PER_RESULT = 8;
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

type ImageVerdict = { image: ChatImage } | { omitted: "unsupported_type" | "invalid_data" | "too_large" };

/** Validates one base64 image payload against the attachment limits. */
function toChatImage(mimeType: string | undefined, data: string, label: string): ImageVerdict {
  const mediaType = (mimeType ?? "").toLowerCase();
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) return { omitted: "unsupported_type" };
  const compact = data.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    return { omitted: "invalid_data" };
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  if ((compact.length / 4) * 3 - padding > MCP_IMAGE_MAX_BYTES) return { omitted: "too_large" };
  return { image: { mediaType: mediaType as ChatImage["mediaType"], dataBase64: compact, label } };
}

/**
 * Splits non-text MCP content into images the model can be shown and
 * descriptors for everything else. Image parts (and embedded image resources)
 * within the limits travel as tool-result images; the descriptor that stays in
 * the data says one was attached. Other binary content — audio, non-image
 * blobs, images over the limits — is described, never inlined.
 */
export function mcpAttachments(
  parts: readonly McpContentPart[],
  label: string,
): { images: ChatImage[]; descriptors: Array<Record<string, unknown>> } {
  const images: ChatImage[] = [];
  const descriptors: Array<Record<string, unknown>> = [];
  const attach = (mimeType: string | undefined, data: string): Record<string, unknown> => {
    if (images.length >= MCP_IMAGES_MAX_PER_RESULT) return { omitted: "too_many_images" };
    const verdict = toChatImage(mimeType, data, label);
    if ("omitted" in verdict) return { omitted: verdict.omitted };
    images.push(verdict.image);
    return { attached: true };
  };
  for (const part of parts) {
    if (part === null || typeof part !== "object" || part.type === "text") continue;
    if (part.type === "resource") {
      const blob = typeof part.resource?.blob === "string" ? part.resource.blob : undefined;
      const imageBlob = blob !== undefined && (part.resource?.mimeType ?? "").toLowerCase().startsWith("image/");
      descriptors.push({
        type: "resource",
        ...(part.resource?.uri ? { uri: redactSecrets(part.resource.uri) } : {}),
        ...(part.resource?.mimeType ? { mimeType: part.resource.mimeType } : {}),
        ...(part.resource?.text ? { textChars: part.resource.text.length } : {}),
        ...(blob !== undefined ? { encodedBytes: blob.length } : {}),
        ...(imageBlob ? attach(part.resource?.mimeType, blob) : {}),
      });
      continue;
    }
    const data = typeof part.data === "string" ? part.data : undefined;
    descriptors.push({
      type: part.type,
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      ...(data !== undefined ? { encodedBytes: data.length } : {}),
      ...(part.type === "image" && data !== undefined ? attach(part.mimeType, data) : {}),
    });
  }
  return { images, descriptors };
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
  const { serverName } = entry;
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
      const client = entry.client;
      let text: string;
      let attachments: Array<Record<string, unknown>> = [];
      let images: ChatImage[] = [];
      let structuredContent: unknown;
      try {
        if (typeof client.callToolDetailed === "function") {
          const detailed = await client.callToolDetailed(tool.name, args as Record<string, unknown>, ctx.signal);
          text = detailed.text;
          ({ images, descriptors: attachments } = mcpAttachments(detailed.content, `${serverName}/${tool.name}`));
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
        ...(images.length > 0 ? { images } : {}),
      };
    },
  });
}

/** The first line of a server-supplied description, bounded, for catalog listings. */
export function mcpToolSummary(tool: Pick<McpTool, "description">, max = 100): string {
  const description = typeof tool.description === "string" ? tool.description : "";
  const line = description.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** One server's tools, as specs plus what the registry needs to compare and index them. */
export type McpServerToolSet = {
  specs: ToolSpec[];
  /** Public name → one-line summary, in tools/list order. */
  summaries: Map<string, string>;
  /** Digest of every advertised field; equal fingerprints advertise identically. */
  fingerprint: string;
};

/**
 * Lists one server's tools and converts them. Throws on a malformed list
 * (non-array, repeated names) or a transport failure — callers decide whether
 * that server then contributes nothing or keeps what it had.
 */
export async function buildMcpServerToolSet(entry: McpClientEntry, signal?: AbortSignal): Promise<McpServerToolSet> {
  const tools: unknown = await entry.client.listTools(signal);
  if (!Array.isArray(tools)) throw new TypeError("tools/list result.tools must be an array");
  const specs: ToolSpec[] = [];
  const summaries = new Map<string, string>();
  const advertised: unknown[] = [];
  const rawNames = new Set<string>();
  for (const value of tools) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const tool = value as Partial<McpTool>;
    if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MCP_RAW_TOOL_NAME_MAX_CHARS)
      continue;
    if (rawNames.has(tool.name)) throw new TypeError(`tools/list repeated tool name ${JSON.stringify(tool.name)}`);
    rawNames.add(tool.name);
    const spec = toToolSpec(entry, tool as McpTool);
    specs.push(spec);
    summaries.set(spec.name, mcpToolSummary(tool));
    advertised.push([spec.name, spec.description, spec.parametersOverride, tool.annotations ?? null]);
  }
  return {
    specs,
    summaries,
    fingerprint: createHash("sha256").update(JSON.stringify(advertised)).digest("hex"),
  };
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
        return (await buildMcpServerToolSet(entry, signal)).specs;
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
