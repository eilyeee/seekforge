/**
 * /mcp: each server's connection state and counts, reconnect one server,
 * switch one off or on, and the login command for remote servers.
 *
 * "Enabled" is SeekForge's existing notion — `trusted: true`, the flag that
 * lets automatic discovery connect a server. Switching one on is therefore a
 * trust grant and asks for confirmation; only a server defined in the user's
 * own config can be switched here, because a repository's trust flag is
 * stripped on load (reviewing a project server is the approval flow's job).
 */

import type { KeyStroke } from "../keymap.js";
import type { McpServerStatus } from "../agent/mcp-registry.js";
import { t } from "../strings.js";
import { listDelta, type ManageMessage, moveIndex } from "./common.js";

export type McpView = {
  kind: "mcp";
  servers: McpServerStatus[];
  index: number;
  /** A server waiting for `y` to be trusted (switched on). */
  confirmEnable?: string;
  message?: ManageMessage;
};

export type McpEffect =
  | { kind: "reconnect"; name: string }
  | { kind: "set-enabled"; name: string; enabled: boolean }
  | { kind: "copy-login"; name: string };

export type McpOutcome =
  | { kind: "update"; view: McpView }
  | { kind: "effect"; view: McpView; effect: McpEffect }
  | { kind: "close" }
  | { kind: "ignore" };

const STATE_MARK: Record<McpServerStatus["state"], string> = {
  connected: "●",
  pending: "…",
  failed: "✗",
  untrusted: "○",
};

export function mcpLoginCommand(name: string): string {
  return `seekforge mcp login ${name}`;
}

export function mcpServerLine(server: McpServerStatus): string {
  const counts =
    server.state === "connected"
      ? ` · ${server.tools} tools${server.prompts !== undefined ? ` · ${server.prompts} prompts` : ""}${
          server.resources !== undefined ? ` · ${server.resources} resources` : ""
        }`
      : "";
  return `${STATE_MARK[server.state]} ${server.name}  ${server.state}  (${server.origin}, ${server.transport})${counts}`;
}

/** Detail lines for the selected server: raw target, failure, next step. */
export function mcpServerDetail(server: McpServerStatus): string[] {
  const lines = [`${server.transport === "http" ? "url" : "command"}: ${server.target}`];
  if (server.error) lines.push(`error: ${server.error.replace(/\s+/g, " ")}`);
  if (server.state === "untrusted") {
    lines.push(server.origin === "user" ? t("manage.mcp.untrustedUser") : t("manage.mcp.untrustedRepo"));
  }
  if (server.transport === "http") lines.push(`${t("manage.mcp.loginHint")} ${mcpLoginCommand(server.name)}`);
  return lines;
}

export function mcpKey(view: McpView, input: string, stroke: KeyStroke): McpOutcome {
  const delta = listDelta(stroke);
  if (delta !== undefined) {
    const { confirmEnable: _dropped, ...rest } = view;
    return { kind: "update", view: { ...rest, index: moveIndex(view.index, delta, view.servers.length) } };
  }
  if (stroke.name === "escape") return { kind: "close" };
  const server = view.servers[view.index];
  if (view.confirmEnable) {
    const { confirmEnable: name, ...rest } = view;
    if (input === "y") return { kind: "effect", view: rest, effect: { kind: "set-enabled", name, enabled: true } };
    return { kind: "update", view: { ...rest, message: { text: t("manage.cancelled"), tone: "dim" } } };
  }
  if (!server || stroke.ctrl || stroke.meta) return { kind: "ignore" };
  if (input === "r") {
    if (server.state === "untrusted") {
      return { kind: "update", view: { ...view, message: { text: t("manage.mcp.notEnabled"), tone: "error" } } };
    }
    return { kind: "effect", view, effect: { kind: "reconnect", name: server.name } };
  }
  if (input === "e" || input === " ") {
    if (server.origin !== "user") {
      return {
        kind: "update",
        view: {
          ...view,
          message: {
            text: server.origin === "plugin" ? t("manage.mcp.pluginOwned") : t("manage.mcp.repoOwned"),
            tone: "error",
          },
        },
      };
    }
    if (server.state === "untrusted") {
      return {
        kind: "update",
        view: {
          ...view,
          confirmEnable: server.name,
          message: { text: `${t("manage.mcp.confirmEnable")} ${server.target}`, tone: "error" },
        },
      };
    }
    return { kind: "effect", view, effect: { kind: "set-enabled", name: server.name, enabled: false } };
  }
  if (input === "l") {
    if (server.transport !== "http") {
      return { kind: "update", view: { ...view, message: { text: t("manage.mcp.loginStdio"), tone: "dim" } } };
    }
    return { kind: "effect", view, effect: { kind: "copy-login", name: server.name } };
  }
  return { kind: "ignore" };
}
