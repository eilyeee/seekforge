/**
 * MCP prompts as invocable slash commands: every prompt advertised by a
 * connected MCP server becomes a `/mcp:<server>:<prompt>` palette entry. On
 * invocation the prompt is fetched (prompts/get) and the rendered string is
 * sent as the task.
 *
 * Naming mirrors the dispatcher's `mcp__<server>__<tool>` convention but uses
 * colons so the command surface reads `/mcp:<server>:<prompt>`, distinct from
 * the `/mcp` listing command. Server and prompt names are sanitized into
 * command-safe tokens. Normalization collisions receive deterministic numeric
 * suffixes, and lookup rebuilds the same command-to-prompt mapping.
 *
 * Argument handling (simplification): MCP prompts may declare typed
 * `arguments`, but the slash surface has no structured form for them. The
 * trailing text after the command is passed as a single best-effort value
 * bound to the prompt's FIRST declared argument (or no args when the prompt
 * declares none / the text is empty). Servers needing multiple structured
 * args are not fully supported from the TUI yet.
 */

import type { McpPromptRef } from "@seekforge/core";

export const MCP_COMMAND_PREFIX = "mcp:";
const SUMMARY_CAP = 60;

/** CommandSpec-compatible palette row (group is always "tools"). */
export type McpPromptCommandSpec = {
  name: string;
  args?: string;
  summary: string;
  group: "tools";
};

/** Sanitizes a server/prompt token into a command-safe form: lowercase [a-z0-9-]. */
function sanitize(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Collapses whitespace runs and caps to `max` chars with an ellipsis. */
function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The command name (without the slash) for a prompt: "mcp:<server>:<prompt>". */
export function mcpPromptCommandName(server: string, prompt: string): string {
  return `${MCP_COMMAND_PREFIX}${sanitize(server)}:${sanitize(prompt)}`;
}

function namedPrompts(prompts: readonly McpPromptRef[]): Array<{ prompt: McpPromptRef; command: string }> {
  const used = new Set<string>();
  const out: Array<{ prompt: McpPromptRef; command: string }> = [];
  for (const prompt of prompts) {
    if (sanitize(prompt.server) === "" || sanitize(prompt.name) === "") continue;
    const base = mcpPromptCommandName(prompt.server, prompt.name);
    let command = base;
    for (let suffix = 2; used.has(command); suffix += 1) command = `${base}-${suffix}`;
    used.add(command);
    out.push({ prompt, command });
  }
  return out;
}

/**
 * One CommandSpec-compatible row per MCP prompt: name
 * "mcp:<server>:<prompt>", args hint "[args]" when the prompt declares any
 * arguments, summary "(mcp <server>) " + description capped at 60 chars.
 * Prompts whose server or name sanitize to nothing are skipped. Colliding
 * normalized names receive a numeric suffix so every row remains invocable.
 */
export function mcpPromptCommandSpecs(prompts: readonly McpPromptRef[]): McpPromptCommandSpec[] {
  return namedPrompts(prompts).map(({ prompt: p, command }) => {
    const hasArgs = (p.arguments?.length ?? 0) > 0;
    return {
      name: command,
      ...(hasArgs ? { args: "[args]" } : {}),
      summary: `(mcp ${sanitize(p.server)}) ${collapse(p.description ?? p.name, SUMMARY_CAP)}`,
      group: "tools" as const,
    };
  });
}

/**
 * Splits a typed command name ("mcp:<server>:<prompt>", no leading slash) into
 * its sanitized server and prompt tokens. Null when it is not an mcp-prompt
 * command or the shape is malformed.
 */
export function parseMcpPromptCommand(name: string): { server: string; prompt: string } | null {
  if (!name.startsWith(MCP_COMMAND_PREFIX)) return null;
  const rest = name.slice(MCP_COMMAND_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return { server: rest.slice(0, sep), prompt: rest.slice(sep + 1) };
}

/**
 * Resolves a typed command name back to its live McpPromptRef using the same
 * collision-safe mapping advertised by mcpPromptCommandSpecs.
 */
export function findPromptByCommand(
  prompts: readonly McpPromptRef[],
  name: string,
): McpPromptRef | null {
  const parsed = parseMcpPromptCommand(name);
  if (!parsed) return null;
  return namedPrompts(prompts).find(({ command }) => command === name)?.prompt ?? null;
}

/**
 * Best-effort arg map for a fetched prompt: binds the trailing slash text to
 * the prompt's first declared argument. Returns undefined when the prompt has
 * no arguments or the text is empty (getMcpPrompt then sends no args).
 */
export function promptArgsFromText(
  prompt: McpPromptRef,
  text: string,
): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const first = prompt.arguments?.[0];
  if (!first || trimmed === "") return undefined;
  return { [first.name]: trimmed };
}

/**
 * One line per MCP prompt for the /prompts listing, mirroring formatMcpLines:
 * "/mcp:<server>:<prompt>  description…" plus a final total. Empty input → a
 * single notice.
 */
export function formatMcpPromptLines(prompts: readonly McpPromptRef[]): string[] {
  const named = namedPrompts(prompts);
  if (named.length === 0) return ["no MCP prompts available (no servers, or none expose prompts)"];
  const lines = named.map(({ prompt: p, command }) => {
    const desc = p.description ? `  ${collapse(p.description, SUMMARY_CAP)}` : "";
    const argHint = (p.arguments?.length ?? 0) > 0 ? " [args]" : "";
    return `/${command}${argHint}${desc}`;
  });
  lines.push(`total: ${lines.length} ${lines.length === 1 ? "prompt" : "prompts"}`);
  return lines;
}
