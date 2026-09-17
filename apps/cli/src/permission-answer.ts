// What a typed answer to a terminal permission prompt means. Shared by the
// headless run prompt (render.ts) and the REPL, which owns its own readline.
//
//   y / yes            allow once
//   a / always         allow, and don't ask again this session — only when the
//                      request is session-grantable; otherwise it is allow-once,
//                      exactly what core would downgrade it to
//   n / no / Enter     deny
//   n: <reason>        deny and tell the agent why (also "no <reason>")
//
// Anything else denies: a prompt that guards a write or a command must not
// read an unrecognized answer as consent.

import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { t } from "./i18n.js";

/** Longest refusal reason passed on; core bounds it again before the model sees it. */
export const MAX_PERMISSION_FEEDBACK_CHARS = 2_000;

export function parsePermissionAnswer(answer: string, opts: { sessionGrantable: boolean }): ConfirmResult {
  const trimmed = answer.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "y" || lower === "yes") return true;
  if (lower === "a" || lower === "always") return opts.sessionGrantable ? { allow: true, remember: "session" } : true;
  const reason = /^(?:n|no)(?:\s*[:：]\s*|\s+)([\s\S]+)$/i.exec(trimmed)?.[1]?.trim();
  if (reason) return { allow: false, feedback: Array.from(reason).slice(0, MAX_PERMISSION_FEEDBACK_CHARS).join("") };
  return false;
}

/** Whether the prompt may offer "don't ask again" for this request. */
export function sessionGrantable(req: PermissionRequest): boolean {
  return req.sessionGrantable !== false;
}

/** The localized answer line for a single (non-hunk) permission prompt. */
export function permissionPromptText(req: PermissionRequest): string {
  return sessionGrantable(req) ? t("render.allowPromptSession") : t("render.allowPrompt");
}
