/** One entry point for the management overlays' key handling. */

import type { KeyStroke } from "../keymap.js";
import { type AgentsEffect, type AgentsView, agentsKey } from "./agents.js";
import { type HooksView, hooksKey } from "./hooks.js";
import { type McpEffect, type McpView, mcpKey } from "./mcp.js";
import { type PermissionsEffect, type PermissionsView, permissionsKey } from "./permissions.js";
import { type ToggleEffect, type ToggleView, toggleKey } from "./toggles.js";

export type ManageView = PermissionsView | McpView | AgentsView | HooksView | ToggleView;

export type ManageEffect = PermissionsEffect | McpEffect | AgentsEffect | ToggleEffect | { kind: "edit-user-config" };

export type ManageOutcome =
  | { kind: "update"; view: ManageView }
  | { kind: "effect"; view: ManageView; effect: ManageEffect }
  | { kind: "close" }
  | { kind: "ignore" };

export function manageKey(view: ManageView, input: string, stroke: KeyStroke): ManageOutcome {
  switch (view.kind) {
    case "permissions":
      return permissionsKey(view, input, stroke);
    case "mcp":
      return mcpKey(view, input, stroke);
    case "agents":
      return agentsKey(view, input, stroke);
    case "hooks":
      return hooksKey(view, input, stroke);
    case "skills":
    case "plugins":
      return toggleKey(view, input, stroke);
  }
}

/** The view with a new status line. */
export function withMessage<T extends ManageView>(view: T, text: string, tone: "dim" | "error" | "ok" = "ok"): T {
  return { ...view, message: { text, tone } };
}
