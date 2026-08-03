import type { ToolSpec } from "../registry.js";
import { browserNavigate } from "./navigate.js";
import { browserConsole, browserScreenshot, browserSnapshot } from "./inspect.js";
import { browserInteractionTools } from "./interact.js";

/**
 * Browser / visual verification tools, backed by an optional Playwright.
 *
 * The set forms one loop: navigate to the page, snapshot/screenshot to see it,
 * click/fill/select/press to drive it, wait for the result, then read the
 * console to find out whether it broke. Everything shares a single headless
 * browser and page (see session.ts).
 */
export const browserTools: ToolSpec[] = [
  browserNavigate,
  browserScreenshot,
  browserSnapshot,
  browserConsole,
  ...browserInteractionTools,
];

export { acquireBrowserLease, disposeBrowser, type BrowserLease } from "./session.js";
export { assertBrowserUrlAllowed, checkBrowserUrl, isLoopbackHost } from "./url-guard.js";
export {
  composeSelector,
  describeTarget,
  describeValue,
  interactionPermission,
  mapInteractionError,
} from "./interact.js";
