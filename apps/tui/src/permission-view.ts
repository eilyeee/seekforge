/**
 * Pure view logic for the permission panel: which body a request renders
 * (diff / markdown plan / plain), the scroll window over it, the key hints it
 * offers, and how a keypress answers it. No Ink imports.
 */

import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { classifyUnifiedDiff } from "./diff.js";
import type { DiffLine } from "./model.js";
import { t } from "./strings.js";

/** Rows of a scrollable permission body. */
export const PERMISSION_BODY_HEIGHT = 18;

/** Longest deny reason the input accepts (core bounds it again). */
export const MAX_DENY_REASON_CHARS = 500;

export type PermissionBody =
  | { kind: "diff"; path: string; lines: DiffLine[] }
  | { kind: "markdown"; text: string }
  | { kind: "plain" };

function looksLikeUnifiedDiff(text: string): boolean {
  return /^--- /m.test(text) && /^@@ /m.test(text);
}

/**
 * The body a request renders. A preview that is not a unified diff, and a long
 * free-text request without a command or path (the plan an `exit_plan_mode`
 * call asks to approve), render as scrollable markdown.
 */
export function permissionBody(request: PermissionRequest): PermissionBody {
  const preview = request.preview;
  if (preview && looksLikeUnifiedDiff(preview.diff)) {
    return { kind: "diff", path: preview.path, lines: classifyUnifiedDiff(preview.diff) };
  }
  if (preview && preview.diff.trim() !== "") return { kind: "markdown", text: preview.diff };
  if (
    !request.command &&
    !request.path &&
    (request.toolName === "exit_plan_mode" || request.description.includes("\n"))
  ) {
    return { kind: "markdown", text: request.description };
  }
  return { kind: "plain" };
}

/** Number of scrollable rows a body has (0 for plain). */
export function bodyRowCount(body: PermissionBody): number {
  if (body.kind === "diff") return body.lines.length;
  if (body.kind === "markdown") return body.text.replace(/\s+$/, "").split("\n").length;
  return 0;
}

/**
 * Where a body opens: a full-file diff starts a few lines above the first
 * change, so an edit at line 300 is visible without scrolling.
 */
export function initialBodyOffset(body: PermissionBody, height = PERMISSION_BODY_HEIGHT): number {
  if (body.kind !== "diff") return 0;
  const first = body.lines.findIndex((line) => line.kind === "add" || line.kind === "del");
  return clampOffset(first < 0 ? 0 : first - 3, body.lines.length, height);
}

export function clampOffset(offset: number, rows: number, height = PERMISSION_BODY_HEIGHT): number {
  return Math.max(0, Math.min(offset, rows - height));
}

/**
 * A window of markdown source lines that still renders correctly: when the
 * window starts inside a fenced code block, the fence is reopened so the slice
 * is shown as code rather than as prose.
 */
export function markdownWindow(text: string, offset: number, height = PERMISSION_BODY_HEIGHT): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const start = clampOffset(offset, lines.length, height);
  let fence: string | null = null;
  for (const line of lines.slice(0, start)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) fence = fence === null ? trimmed : null;
  }
  const window = lines.slice(start, start + height);
  return [...(fence !== null ? [fence] : []), ...window].join("\n");
}

/** Whether "don't ask again this session" is honored for this request. */
export function offersSessionGrant(request: PermissionRequest): boolean {
  return request.sessionGrantable !== false;
}

/** Whether "always allow" (a saved rule) is offered for this request. */
export function offersAlways(request: PermissionRequest): boolean {
  return request.rememberRule !== undefined && offersSessionGrant(request);
}

/** The footer hint line for a pending request, listing only what it offers. */
export function permissionHints(
  request: PermissionRequest,
  opts: { ideConnected?: boolean; typingReason?: boolean } = {},
): string {
  if (opts.typingReason) return t("hints.permissionReason");
  const hunks = request.hunks !== undefined && request.hunks.length > 1;
  const parts = [hunks ? t("hints.hunks") : t("hints.allow")];
  if (!hunks && offersSessionGrant(request)) parts.push(t("hints.allowSession"));
  if (!hunks && offersAlways(request)) parts.push(t("hints.always"));
  parts.push(t("hints.denyReason"), t("hints.deny"));
  const body = permissionBody(request);
  if (bodyRowCount(body) > PERMISSION_BODY_HEIGHT) parts.push(t("hints.scroll"));
  if (opts.ideConnected && request.preview && body.kind === "diff") parts.push(t("hints.ideDiff"));
  return parts.join(" · ");
}

/** A deny carrying the user's reason; an empty reason is a plain deny. */
export function denyWithReason(reason: string): ConfirmResult {
  const trimmed = reason.trim();
  return trimmed === "" ? false : { allow: false, feedback: trimmed.slice(0, MAX_DENY_REASON_CHARS) };
}
