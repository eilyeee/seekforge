import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool } from "../registry.js";
import type { ToolContext } from "../index.js";
import { resolveForRead } from "../sandbox.js";
import type { PermissionName } from "@seekforge/shared";
import { loadPlaywright, type PlaywrightPage } from "./playwright.js";
import {
  capturedActivity,
  currentPageIsLoopback,
  currentPageUrl,
  requirePage,
  runBrowserOperation,
} from "./session.js";

/**
 * Driving the page, not just watching it.
 *
 * browser_navigate + the inspect tools can only observe a URL. Verifying real
 * behaviour — log in, fill the form, submit, assert the result — needs the
 * agent to act on the page, which is what these tools add.
 *
 * Permission: an interaction is classified from WHERE the loaded page points.
 * Clicking around your own dev server is ordinary work ("execute"); clicking on
 * a public site can create real side effects on someone else's system, so it is
 * "env" — confirmed on every call, even in auto mode. The page itself was
 * already approved once by browser_navigate; this is the second gate for the
 * actions taken on it.
 */

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const MAX_ACTION_TIMEOUT_MS = 30_000;
// Selectors and typed text appear in confirmation prompts; keep them readable.
const MAX_DESCRIBED_CHARS = 120;

const timeoutField = z
  .number()
  .int()
  .min(100)
  .max(MAX_ACTION_TIMEOUT_MS)
  .optional()
  .describe(`How long to wait for the element, in ms (default ${DEFAULT_ACTION_TIMEOUT_MS}).`);

const selectorField = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    "Playwright selector for the target element: CSS ('#login button'), text ('text=Sign in'), or role ('role=button[name=\"Save\"]'). Take it from browser_snapshot.",
  );

const indexField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Which match to act on when the selector matches several (0-based). Omit when it matches exactly one.");

/**
 * Narrow a selector to one match. Playwright is strict by default — a selector
 * matching several elements is an error, not a silent "first one" — so an
 * explicit index is how the caller resolves the ambiguity.
 */
export function composeSelector(selector: string, index?: number): string {
  return index === undefined ? selector : `${selector} >> nth=${index}`;
}

/**
 * Shorten free text for a confirmation prompt. NOT for a selector or a url:
 * those name the target of the action, and a prompt that hides part of the
 * target is a prompt the user cannot actually judge.
 */
export function describeValue(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DESCRIBED_CHARS ? `${collapsed.slice(0, MAX_DESCRIBED_CHARS)}…` : collapsed;
}

/** Collapse whitespace in a target (selector or url) without truncating it. */
export function describeTarget(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Permission level for acting on the loaded page. Loopback (the developer's own
 * dev server) is ordinary work; anything else is always confirmed.
 *
 * With no page loaded the call cannot touch anything — run() fails immediately
 * with `no_page` — so it stays at "execute" rather than prompting the user to
 * approve an action that provably has no target.
 */
export function interactionPermission(workspace: string): PermissionName {
  const url = currentPageUrl(workspace);
  if (url === undefined) return "execute";
  return currentPageIsLoopback(workspace) ? "execute" : "env";
}

/** Suffix naming the page an interaction lands on, for the confirmation prompt. */
function onPage(workspace: string): string {
  const url = currentPageUrl(workspace);
  return url ? ` on ${describeTarget(url)}` : "";
}

/**
 * Pin the interaction to the page the user was shown.
 *
 * The permission level is decided from where the page points, and the page is
 * shared across this WORKSPACE's tools — a parallel subagent, or a click of our
 * own that navigated, can move it between the approval and the action.
 * Recording the url in `prepare` (which runs before the prompt) and re-checking
 * it in `act` means an action lands on the page that was approved, or not at
 * all.
 */
async function capturePage(_args: unknown, ctx: ToolContext): Promise<{ state: { url: string | undefined } }> {
  return { state: { url: currentPageUrl(ctx.workspace) } };
}

/**
 * Translate a Playwright failure into an actionable ToolError. Its own messages
 * are long and stack-like; the agent needs the failure MODE (nothing matched /
 * too many matched) to know what to do differently.
 */
export function mapInteractionError(err: unknown, action: string, selector: string): ToolError {
  if (err instanceof ToolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/strict mode violation/i.test(message)) {
    const counted = /resolved to (\d+) elements/i.exec(message)?.[1];
    return new ToolError(
      "ambiguous_selector",
      `${selector} matches ${counted ?? "several"} elements — pass index to pick one, or use a more specific selector.`,
    );
  }
  if (err instanceof Error && (err.name === "TimeoutError" || /Timeout .* exceeded/i.test(message))) {
    return new ToolError(
      "element_not_found",
      `${action} timed out waiting for ${selector} — call browser_snapshot to see what the page actually contains.`,
    );
  }
  return new ToolError("interaction_failed", `${action} failed: ${message}`);
}

type ActionOutcome = {
  /** The page's url after the action; a click may have navigated. */
  url: string;
  /** True when the action moved the page somewhere else. */
  navigated: boolean;
  /** Uncaught page errors raised while the action ran — usually the answer. */
  errorsDuring: string[];
};

/**
 * Run one page action and report what it did to the page. The agent's real
 * question after a click is "did that work?", so every interaction answers with
 * the resulting url and any errors the page raised while acting.
 */
async function act(
  // `prepared` carries the url captured before the prompt. A follow-up step
  // within one tool call (fill → submit) deliberately passes a context without
  // it: the first step may have navigated the page on purpose.
  ctx: { workspace: string; signal?: AbortSignal; prepared?: unknown },
  label: string,
  selector: string,
  action: (page: PlaywrightPage) => Promise<unknown>,
): Promise<{ page: PlaywrightPage; outcome: ActionOutcome }> {
  await loadPlaywright();
  const page = requirePage(ctx.workspace);
  const urlBefore = page.url();
  const approved = (ctx.prepared as { url?: string } | undefined)?.url;
  if (approved !== undefined && approved !== urlBefore) {
    throw new ToolError(
      "page_changed",
      `the page moved from ${approved} to ${urlBefore} before this action ran — re-read it with browser_snapshot and retry`,
    );
  }
  const errorsBefore = capturedActivity(ctx.workspace).errors.length;
  try {
    await runBrowserOperation(ctx.workspace, action(page), ctx.signal, label);
  } catch (err) {
    throw mapInteractionError(err, label, selector);
  }
  const url = page.url();
  return {
    page,
    outcome: {
      url,
      navigated: url !== urlBefore,
      errorsDuring: capturedActivity(ctx.workspace).errors.slice(errorsBefore),
    },
  };
}

const clickSchema = z.object({
  selector: selectorField,
  index: indexField,
  timeoutMs: timeoutField,
});

export const browserClick = defineTool({
  name: "browser_click",
  description:
    "Click an element on the loaded page (button, link, checkbox…), waiting for it to be actionable first. " +
    "Returns the resulting url, whether the click navigated, and any page errors it raised. " +
    "Pass index when the selector matches several elements. Requires browser_navigate first; clicking a page outside loopback is always confirmed.",
  schema: clickSchema,
  prepare: capturePage,
  classify: (args, ctx) => ({
    permission: interactionPermission(ctx.workspace),
    description: `Click ${describeTarget(args.selector)}${onPage(ctx.workspace)}`,
  }),
  async run(args, ctx) {
    const selector = composeSelector(args.selector, args.index);
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const { outcome } = await act(ctx, "Click", selector, (page) => page.click(selector, { timeout }));
    return { data: { selector, ...outcome } };
  },
});

const fillSchema = z.object({
  selector: selectorField,
  text: z.string().max(100_000).describe("Text to enter; replaces the field's current value."),
  index: indexField,
  submit: z.boolean().optional().describe("Press Enter after filling, to submit the form (default false)."),
  timeoutMs: timeoutField,
});

export const browserFill = defineTool({
  name: "browser_fill",
  description:
    "Type text into the input, textarea or contenteditable matched by selector on the loaded page, replacing whatever it currently holds. " +
    "Set submit:true to press Enter afterwards. Returns the resulting url, whether it navigated, and any page errors. " +
    "Requires browser_navigate first; filling a page outside loopback is always confirmed.",
  schema: fillSchema,
  prepare: capturePage,
  classify: (args, ctx) => ({
    permission: interactionPermission(ctx.workspace),
    description:
      `Type "${describeValue(args.text)}" into ${describeTarget(args.selector)}${onPage(ctx.workspace)}` +
      (args.submit ? " and submit" : ""),
  }),
  async run(args, ctx) {
    const selector = composeSelector(args.selector, args.index);
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const { page, outcome } = await act(ctx, "Fill", selector, (p) => p.fill(selector, args.text, { timeout }));
    if (!args.submit) {
      // The typed text is deliberately NOT echoed back: it may be a credential,
      // and the model already knows what it sent.
      return { data: { selector, filled: args.text.length, submitted: false, ...outcome } };
    }
    const submitted = await act({ workspace: ctx.workspace, signal: ctx.signal }, "Submit", selector, () =>
      page.press(selector, "Enter", { timeout }),
    );
    return {
      data: {
        selector,
        filled: args.text.length,
        submitted: true,
        ...submitted.outcome,
        // Errors from both steps, so a failure during fill is not lost.
        errorsDuring: [...outcome.errorsDuring, ...submitted.outcome.errorsDuring],
      },
    };
  },
});

const selectSchema = z
  .object({
    selector: selectorField,
    value: z.string().max(1024).optional().describe("Option value attribute to select."),
    label: z.string().max(1024).optional().describe("Visible option text to select, when the value is unknown."),
    index: indexField,
    timeoutMs: timeoutField,
  })
  .refine((a) => (a.value === undefined) !== (a.label === undefined), {
    message: "pass exactly one of value or label",
  });

export const browserSelect = defineTool({
  name: "browser_select",
  description:
    "Choose an option in the <select> matched by selector on the loaded page, by option value or by visible label (pass exactly one). " +
    "Returns the option(s) actually selected plus the resulting url and any page errors. " +
    "Requires browser_navigate first; selecting on a page outside loopback is always confirmed.",
  schema: selectSchema,
  prepare: capturePage,
  classify: (args, ctx) => ({
    permission: interactionPermission(ctx.workspace),
    description: `Select ${describeValue(args.value ?? args.label ?? "")} in ${describeTarget(args.selector)}${onPage(ctx.workspace)}`,
  }),
  async run(args, ctx) {
    const selector = composeSelector(args.selector, args.index);
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const target = args.value !== undefined ? args.value : { label: args.label! };
    let selected: string[] = [];
    const { outcome } = await act(ctx, "Select", selector, async (page) => {
      selected = await page.selectOption(selector, target, { timeout });
    });
    if (selected.length === 0) {
      throw new ToolError(
        "option_not_found",
        `No option matching ${JSON.stringify(args.value ?? args.label)} in ${selector} — call browser_snapshot to see the choices.`,
      );
    }
    return { data: { selector, selected, ...outcome } };
  },
});

const pressSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe('Key or chord in Playwright notation: "Enter", "Escape", "ArrowDown", "Control+A".'),
  selector: selectorField.optional().describe("Element to focus first; omit to send the key to whatever has focus."),
  index: indexField,
  timeoutMs: timeoutField,
});

export const browserPress = defineTool({
  name: "browser_press",
  description:
    "Press a key or chord on the loaded page — Enter to submit, Escape to dismiss, arrows to move through a listbox. " +
    "Give a selector to focus an element first, or omit it to send the key to whatever currently has focus. " +
    "Requires browser_navigate first; pressing keys on a page outside loopback is always confirmed.",
  schema: pressSchema,
  prepare: capturePage,
  classify: (args, ctx) => ({
    permission: interactionPermission(ctx.workspace),
    description:
      `Press ${describeValue(args.key)}` +
      (args.selector ? ` on ${describeValue(args.selector)}` : "") +
      onPage(ctx.workspace),
  }),
  async run(args, ctx) {
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const selector = args.selector === undefined ? undefined : composeSelector(args.selector, args.index);
    const label = selector ?? "the focused element";
    const { outcome } = await act(ctx, "Press", label, (page) =>
      selector === undefined ? page.keyboard.press(args.key) : page.press(selector, args.key, { timeout }),
    );
    return { data: { key: args.key, ...(selector !== undefined ? { selector } : {}), ...outcome } };
  },
});

const waitSchema = z
  .object({
    selector: selectorField.optional(),
    text: z.string().min(1).max(1024).optional().describe("Visible text to wait for, when there is no good selector."),
    state: z
      .enum(["attached", "visible", "hidden"])
      .optional()
      .describe("What to wait for: visible (default), attached to the DOM, or hidden/gone."),
    timeoutMs: timeoutField,
  })
  .refine((a) => (a.selector === undefined) !== (a.text === undefined), {
    message: "pass exactly one of selector or text",
  });

export const browserWaitFor = defineTool({
  name: "browser_wait_for",
  description:
    "Wait until an element (selector) or some visible text appears, or is hidden, on the loaded page — use it after an action that renders asynchronously, instead of screenshotting a half-drawn page. " +
    "Pass exactly one of selector or text. Fails with element_not_found on timeout. Read-only; requires browser_navigate first.",
  schema: waitSchema,
  prepare: capturePage,
  // Waiting observes; it never changes the page, so it stays read-only
  // regardless of which host the page came from.
  classify: (args) => ({
    permission: "readonly",
    description: `Wait for ${describeTarget(args.selector ?? `text=${args.text ?? ""}`)}`,
  }),
  async run(args, ctx) {
    // Playwright's text engine takes the same selector slot, so waiting for
    // text is just a selector with a different prefix.
    const selector = args.selector ?? `text=${args.text!}`;
    const state = args.state ?? "visible";
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const { outcome } = await act(ctx, "Wait", selector, (page) => page.waitForSelector(selector, { state, timeout }));
    return { data: { selector, state, ...outcome } };
  },
});

const uploadSchema = z.object({
  selector: selectorField,
  path: z.string().describe("Workspace-relative path of the file to attach (e.g. fixtures/avatar.png)."),
  index: indexField,
  timeoutMs: timeoutField,
});

export const browserUpload = defineTool({
  name: "browser_upload",
  description:
    "Attach a workspace file to the file input matched by selector on the loaded page, so an upload flow can be exercised end to end. " +
    "Returns the resulting url, whether it navigated, and any page errors. Requires browser_navigate first; uploading on a page outside loopback is always confirmed.",
  schema: uploadSchema,
  prepare: capturePage,
  classify: (args, ctx) => ({
    permission: interactionPermission(ctx.workspace),
    // The path is shown raw: handing a file to a page is the one interaction
    // that takes something out of the workspace, and which file it is decides
    // whether that is fine.
    description: `Upload ${args.path} to ${describeTarget(args.selector)}${onPage(ctx.workspace)}`,
    path: args.path,
  }),
  async run(args, ctx) {
    // Resolved through the sandbox for the same reason every read is: the page
    // is untrusted input, and "../../.ssh/id_rsa" is a plausible thing for it
    // to have asked for.
    const resolved = resolveForRead(ctx.workspace, args.path);
    // Playwright first, so a missing browser reports itself the same way it
    // does for every other tool here rather than as a file problem.
    await loadPlaywright();
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new ToolError("not_found", `File not found: ${args.path}`);
    }
    const selector = composeSelector(args.selector, args.index);
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const { outcome } = await act(ctx, "Upload", selector, (page) =>
      page.setInputFiles(selector, resolved, { timeout }),
    );
    return { data: { selector, path: args.path, ...outcome } };
  },
});

export const browserInteractionTools = [
  browserClick,
  browserFill,
  browserSelect,
  browserPress,
  browserWaitFor,
  browserUpload,
];
