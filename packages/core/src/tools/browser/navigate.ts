import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool } from "../registry.js";
import { checkBrowserUrl } from "./url-guard.js";
import { getPage, resetCapture, runBrowserOperation } from "./session.js";
import type { PlaywrightResponse } from "./playwright.js";

const NAV_TIMEOUT_MS = 30_000;

const navigateSchema = z.object({
  url: z.string().describe("Absolute http(s) url to open in a headless browser (e.g. your dev server)."),
});

export const browserNavigate = defineTool({
  name: "browser_navigate",
  description:
    "Open an absolute http(s) url in a shared headless browser so you can verify a frontend change; reuses one browser+page across calls. " +
    "Returns the final url, HTTP status, and page title, and starts capturing console/errors/failed-requests for browser_console. " +
    "Outward network action — always requires user confirmation. Loopback dev servers are allowed; other private addresses are refused.",
  schema: navigateSchema,
  // "env" level: always confirmed even in auto mode, like web_fetch — this
  // takes an outward network action and the raw url is shown to the user.
  classify: (args) => ({
    permission: "env",
    description: `Open in browser: ${args.url}`,
    command: `GET ${args.url}`,
  }),
  async run(args, ctx) {
    const url = checkBrowserUrl(args.url);
    if (ctx.signal?.aborted) throw new ToolError("cancelled", "Browser navigation cancelled");
    const p = await getPage(ctx.workspace);
    // Reset capture so browser_console reflects only the new page.
    resetCapture(ctx.workspace);
    let resp: PlaywrightResponse | null;
    try {
      resp = await runBrowserOperation(
        ctx.workspace,
        p.goto(url.toString(), { waitUntil: "load", timeout: NAV_TIMEOUT_MS }),
        ctx.signal,
        "Browser navigation",
      );
    } catch (err) {
      if (err instanceof ToolError && err.code === "cancelled") throw err;
      throw new ToolError(
        "navigation_failed",
        `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const title = await runBrowserOperation(ctx.workspace, p.title(), ctx.signal, "Browser title read").catch(
      (err: unknown) => {
        if (err instanceof ToolError && err.code === "cancelled") throw err;
        return "";
      },
    );
    return {
      data: {
        url: p.url(),
        status: resp?.status?.() ?? null,
        title,
      },
    };
  },
});
