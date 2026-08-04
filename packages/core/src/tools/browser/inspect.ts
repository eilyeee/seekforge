import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatImage } from "@seekforge/shared";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool } from "../registry.js";
import { resolveForWrite } from "../sandbox.js";
import { loadPlaywright } from "./playwright.js";
import { capturedActivity, requirePage, runBrowserOperation } from "./session.js";

/** Read-only ways to "see" the loaded page: a PNG, a text snapshot, the console. */

const ACTION_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_CHARS = 12_000;
const MAX_ELEMENTS = 100;

const screenshotSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Optional workspace-relative path for the PNG (default: .seekforge/uploads/screenshot-<ts>.png)."),
});

/**
 * Ceiling on an attached screenshot. Base64 inflates it by a third, and the
 * result is written into the session transcript and resent on later turns until
 * micro-compaction clears it — so the bound is about what a conversation can
 * afford to carry, not what the API would accept. A full-page PNG is normally
 * well under this; a page that renders to megabytes stays a path.
 */
const MAX_ATTACHED_IMAGE_BYTES = 1024 * 1024;

export const browserScreenshot = defineTool({
  name: "browser_screenshot",
  description:
    "Capture a full-page PNG of the currently loaded browser page and save it under the workspace (default .seekforge/uploads/, or a given path); returns the saved path. " +
    "Read-only on the page — call browser_navigate first. On a provider that accepts images the screenshot is attached to this result and you can simply look at it; otherwise pass the path to image_analyze.",
  schema: screenshotSchema,
  // Writes a PNG artifact into the workspace but takes no new outward action;
  // classify as "execute" (the page was already loaded via a confirmed navigate).
  classify: (args) => ({
    permission: "execute",
    description: "Screenshot the current browser page",
    ...(args.path !== undefined ? { path: args.path } : {}),
  }),
  async run(args, ctx) {
    await loadPlaywright();
    const p = requirePage();
    const rel = args.path ?? path.join(".seekforge", "uploads", `screenshot-${Date.now()}.png`);
    const resolved = resolveForWrite(ctx.workspace, rel);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    try {
      await runBrowserOperation(
        p.screenshot({ path: resolved, fullPage: true, timeout: ACTION_TIMEOUT_MS }),
        ctx.signal,
        "Browser screenshot",
      );
    } catch (err) {
      if (err instanceof ToolError && err.code === "cancelled") throw err;
      throw new ToolError(
        "screenshot_failed",
        `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Attach the bytes, not just the path. A path is only useful while the file
    // is still there and only to a tool that can open it; the attachment is
    // what lets a model with eyes see the page directly. Providers that cannot
    // carry images ignore it (and say so), so this costs them nothing.
    const image = attachScreenshot(resolved, rel);
    return { data: { path: rel }, ...(image ? { images: [image] } : {}) };
  },
});

/**
 * Read a just-written screenshot back as an attachable image, or nothing.
 *
 * Bounded and best effort on purpose: a screenshot too large to attach is
 * still on disk and still reachable through image_analyze, so failing the whole
 * tool call over the attachment would take away more than it gives.
 */
function attachScreenshot(resolved: string, rel: string): ChatImage | undefined {
  try {
    const bytes = fs.statSync(resolved).size;
    if (bytes <= 0 || bytes > MAX_ATTACHED_IMAGE_BYTES) return undefined;
    return { mediaType: "image/png", dataBase64: fs.readFileSync(resolved).toString("base64"), label: rel };
  } catch {
    return undefined;
  }
}

export const browserSnapshot = defineTool({
  name: "browser_snapshot",
  description:
    "Return a concise text snapshot of the currently loaded browser page (title, url, headings, links, buttons, inputs, and visible text) so you can 'see' it without an image. " +
    "Read the inputs/buttons it lists to pick a selector for browser_click / browser_fill. Read-only — call browser_navigate first.",
  schema: z.object({}),
  // Pure read of the already-loaded page.
  classify: () => ({ permission: "readonly", description: "Snapshot the current browser page" }),
  async run(_args, ctx) {
    await loadPlaywright();
    const p = requirePage();
    // Extract a compact accessibility-ish summary in the page context. DOM
    // globals are reached through globalThis so this typechecks without the
    // "dom" lib (the body runs in the browser, not in Node).
    //
    // The body MUST NOT declare named inner functions (`const textOf = …`).
    // Playwright ships this function to the browser as source, and esbuild's
    // keepNames transform — which tsx enables, so every run from source hits
    // it — rewrites named function bindings into `__name(…)` calls that do not
    // exist in the page. Anonymous callbacks in argument position are left
    // alone, so everything below stays inline. scripts/browser-tools-smoke.mts
    // runs under tsx and fails if this regresses.
    const snap = (await runBrowserOperation(
      p.evaluate((max: number) => {
        type ElementLike = {
          textContent?: string | null;
          tagName: string;
          value?: string;
          getAttribute(name: string): string | null;
        };
        type DocumentLike = {
          title: string;
          body?: { innerText?: string };
          querySelectorAll(selector: string): ArrayLike<ElementLike>;
        };
        const g = globalThis as unknown as { document: DocumentLike; location: { href: string } };
        const doc = g.document;
        const headings = Array.from(doc.querySelectorAll("h1,h2,h3"))
          .slice(0, max)
          .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent ?? "").replace(/\s+/g, " ").trim()}`)
          .filter((s) => s.length > 4);
        const links = Array.from(doc.querySelectorAll("a[href]"))
          .slice(0, max)
          .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        const buttons = Array.from(
          doc.querySelectorAll("button, [role=button], input[type=submit], input[type=button]"),
        )
          .slice(0, max)
          .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim() || el.value || "")
          .filter(Boolean);
        const inputs = Array.from(doc.querySelectorAll("input, textarea, select"))
          .slice(0, max)
          .map((el) =>
            [el.getAttribute("name"), el.getAttribute("type"), el.getAttribute("placeholder")]
              .filter(Boolean)
              .join(" "),
          );
        const text = (doc.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
        return { title: doc.title, url: g.location.href, headings, links, buttons, inputs, text };
      }, MAX_ELEMENTS),
      ctx.signal,
      "Browser snapshot",
    )) as {
      title: string;
      url: string;
      headings: string[];
      links: string[];
      buttons: string[];
      inputs: string[];
      text: string;
    };
    const text =
      snap.text.length > MAX_SNAPSHOT_CHARS ? snap.text.slice(0, MAX_SNAPSHOT_CHARS) + "\n… [truncated]" : snap.text;
    return { data: { ...snap, text } };
  },
});

export const browserConsole = defineTool({
  name: "browser_console",
  description:
    "Return console messages, uncaught page errors, and failed network requests captured since the last browser_navigate — the key signal for whether your change broke the page. " +
    "Interactions do not clear it, so a click's errors are still here afterwards. Read-only — call browser_navigate first.",
  schema: z.object({}),
  classify: () => ({ permission: "readonly", description: "Read the current browser page's console" }),
  async run() {
    await loadPlaywright();
    requirePage();
    return { data: capturedActivity() };
  },
});
