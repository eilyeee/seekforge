/**
 * /mcp: each server's connection state and counts, reconnect one server,
 * switch a user server off or on, approve or reject a repository server, and
 * the login command for remote servers.
 *
 * Two different grants, matching core's connection rule:
 * - a server in the user's own config connects when it is `trusted: true`, so
 *   "enable" writes that flag (and asks first: it is a trust grant);
 * - a server the repository defines connects only once the user approved that
 *   exact definition for this workspace, so the definition is shown before `y`
 *   records the approval. Rejecting needs no confirmation: it grants nothing.
 */

import type { KeyStroke } from "../keymap.js";
import type { McpServerStatus } from "../agent/mcp-registry.js";
import { stripControls } from "../format.js";
import { t } from "../strings.js";
import { listDelta, type ManageMessage, moveIndex } from "./common.js";

export type McpView = {
  kind: "mcp";
  servers: McpServerStatus[];
  index: number;
  /** A user server waiting for `y` to be trusted (switched on). */
  confirmEnable?: string;
  /** A repository server whose definition is shown, waiting for `y` to be approved. */
  confirmApprove?: string;
  message?: ManageMessage;
};

export type McpEffect =
  | { kind: "reconnect"; name: string }
  | { kind: "set-enabled"; name: string; enabled: boolean }
  | { kind: "decide-project"; name: string; decision: "approve" | "reject" }
  | { kind: "copy-login"; name: string };

export type McpOutcome =
  | { kind: "update"; view: McpView }
  | { kind: "effect"; view: McpView; effect: McpEffect }
  | { kind: "close" }
  | { kind: "ignore" };

const STATE_MARK: Record<McpServerStatus["state"], string> = {
  connected: "●",
  failed: "✗",
  pending: "?",
  rejected: "⊘",
  disabled: "○",
  invalid: "!",
};

/** Lines of a definition shown under the list; longer ones are cut with a note. */
const MAX_DEFINITION_LINES = 24;

/**
 * The login command to copy. The name may come from a repository, and the line
 * is pasted into a shell, so anything but a plain token is single-quoted (the
 * CLI's shellQuote rule, apps/cli/src/runner.ts). Quoting does not stop the
 * CLI reading a name that starts with `-` as an option, so such a name follows
 * `--`.
 */
export function mcpLoginCommand(name: string): string {
  const arg = /^[\w.:@-]+$/.test(name) ? name : `'${name.split("'").join("'\\''")}'`;
  return `seekforge mcp login ${name.startsWith("-") ? "-- " : ""}${arg}`;
}

function isRemote(server: McpServerStatus): boolean {
  return server.transport === "http" || server.transport === "sse";
}

export function mcpServerLine(server: McpServerStatus): string {
  const counts =
    server.state === "connected"
      ? ` · ${server.tools} tools${server.prompts !== undefined ? ` · ${server.prompts} prompts` : ""}${
          server.resources !== undefined ? ` · ${server.resources} resources` : ""
        }`
      : "";
  return stripControls(
    `${STATE_MARK[server.state]} ${server.name}  ${server.state}  (${server.origin}, ${server.transport ?? "?"})${counts}`,
  );
}

function definitionLines(definition: string): string[] {
  const lines = definition.split("\n");
  if (lines.length <= MAX_DEFINITION_LINES) return lines;
  return [
    ...lines.slice(0, MAX_DEFINITION_LINES),
    `… ${lines.length - MAX_DEFINITION_LINES} ${t("manage.mcp.moreLines")}`,
  ];
}

/**
 * Detail lines for the selected server: raw target, failure, next step. A
 * repository chose the name and target, and a server the error, so control
 * characters are blanked (the definition is JSON, which already escapes them).
 */
export function mcpServerDetail(server: McpServerStatus, view?: Pick<McpView, "confirmApprove">): string[] {
  if (view?.confirmApprove === server.name && server.definition !== undefined) {
    return [t("manage.mcp.reviewDefinition"), ...definitionLines(server.definition).map(stripControls)];
  }
  return rawDetail(server).map(stripControls);
}

function rawDetail(server: McpServerStatus): string[] {
  const lines = [`${isRemote(server) ? "url" : "command"}: ${server.target}`];
  if (server.error) lines.push(`error: ${server.error.replace(/\s+/g, " ")}`);
  if (server.state === "disabled") {
    lines.push(server.origin === "user" ? t("manage.mcp.untrustedUser") : t("manage.mcp.disabledOther"));
  } else if (server.state === "pending") {
    lines.push(t("manage.mcp.pendingRepo"));
  } else if (server.state === "rejected") {
    lines.push(t("manage.mcp.rejectedRepo"));
  }
  if (isRemote(server)) lines.push(`${t("manage.mcp.loginHint")} ${mcpLoginCommand(server.name)}`);
  return lines;
}

function withText(view: McpView, text: string, tone: ManageMessage["tone"]): McpOutcome {
  return { kind: "update", view: { ...view, message: { text, tone } } };
}

export function mcpKey(view: McpView, input: string, stroke: KeyStroke): McpOutcome {
  const { confirmEnable, confirmApprove, ...idle } = view;
  const delta = listDelta(stroke);
  if (delta !== undefined) {
    return { kind: "update", view: { ...idle, index: moveIndex(view.index, delta, view.servers.length) } };
  }
  if (stroke.name === "escape") {
    // Esc backs out of a pending confirmation before it closes the panel.
    if (confirmEnable || confirmApprove) return withText(idle, t("manage.cancelled"), "dim");
    return { kind: "close" };
  }
  if (confirmEnable) {
    if (input === "y") {
      return { kind: "effect", view: idle, effect: { kind: "set-enabled", name: confirmEnable, enabled: true } };
    }
    return withText(idle, t("manage.cancelled"), "dim");
  }
  if (confirmApprove) {
    if (input === "y") {
      return {
        kind: "effect",
        view: idle,
        effect: { kind: "decide-project", name: confirmApprove, decision: "approve" },
      };
    }
    return withText(idle, t("manage.cancelled"), "dim");
  }
  const server = view.servers[view.index];
  if (!server || stroke.ctrl || stroke.meta) return { kind: "ignore" };
  const repository = server.origin === "repository";
  if (input === "r") {
    if (server.state === "disabled" && server.origin === "user")
      return withText(view, t("manage.mcp.notEnabled"), "error");
    if (repository && (server.state === "pending" || server.state === "rejected")) {
      return withText(view, t("manage.mcp.notApproved"), "error");
    }
    return { kind: "effect", view, effect: { kind: "reconnect", name: server.name } };
  }
  if (input === "e" || input === " ") {
    if (server.origin !== "user") {
      return withText(
        view,
        server.origin === "plugin" ? t("manage.mcp.pluginOwned") : t("manage.mcp.repoOwned"),
        "error",
      );
    }
    if (server.state === "disabled") {
      return {
        kind: "update",
        view: {
          ...view,
          confirmEnable: server.name,
          message: { text: stripControls(`${t("manage.mcp.confirmEnable")} ${server.target}`), tone: "error" },
        },
      };
    }
    return { kind: "effect", view, effect: { kind: "set-enabled", name: server.name, enabled: false } };
  }
  if (input === "a" || input === "x") {
    if (!repository) return withText(view, t("manage.mcp.notRepository"), "error");
    if (input === "x") {
      if (server.state === "rejected") return withText(view, t("manage.mcp.alreadyRejected"), "dim");
      return { kind: "effect", view, effect: { kind: "decide-project", name: server.name, decision: "reject" } };
    }
    if (server.state !== "pending" && server.state !== "rejected") {
      return withText(view, t("manage.mcp.alreadyApproved"), "dim");
    }
    return {
      kind: "update",
      view: {
        ...view,
        confirmApprove: server.name,
        message: { text: t("manage.mcp.confirmApprove"), tone: "error" },
      },
    };
  }
  if (input === "l") {
    if (!isRemote(server)) return withText(view, t("manage.mcp.loginStdio"), "dim");
    return { kind: "effect", view, effect: { kind: "copy-login", name: server.name } };
  }
  return { kind: "ignore" };
}
