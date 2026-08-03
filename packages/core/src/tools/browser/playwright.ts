import { ToolError } from "../errors.js";

/**
 * The Playwright binding.
 *
 * Playwright is an OPTIONAL dependency: it is imported dynamically (never at
 * the top level) so typecheck, build and tests all pass with it absent. The
 * import specifier is held in a variable so TypeScript does not statically
 * resolve the module — it would otherwise error when the dep is not installed —
 * and a missing module surfaces as an actionable `browser_unavailable` error
 * rather than a crash.
 *
 * The structural types below mirror exactly the members the tools call. They
 * exist because the real types ship with the dependency we may not have.
 */

/**
 * Import specifier for the Playwright module. `SEEKFORGE_PLAYWRIGHT` lets a
 * user point at an installation outside this package — a bare `playwright-core`
 * only resolves from SeekForge's own node_modules, which leaves a globally
 * installed Playwright unusable.
 */
function playwrightSpecifier(): string {
  const override = process.env.SEEKFORGE_PLAYWRIGHT?.trim();
  return override ? override : "playwright-core";
}

export const INSTALL_HINT =
  "browser tools need Playwright: pnpm add -w playwright-core && npx playwright install chromium " +
  "(or point SEEKFORGE_PLAYWRIGHT at an existing playwright-core installation)";

export type PlaywrightRequest = { url(): string; failure(): { errorText: string } | null };
export type PlaywrightRoute = {
  request(): PlaywrightRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};
export type PlaywrightConsoleMessage = { type(): string; text(): string };
export type PlaywrightResponse = { status(): number };

/** Options every action-scoped Playwright call accepts. */
export type ActionOptions = { timeout?: number };

export type PlaywrightPage = {
  on(event: "console", cb: (msg: PlaywrightConsoleMessage) => void): void;
  on(event: "pageerror", cb: (err: Error) => void): void;
  on(event: "requestfailed", cb: (req: PlaywrightRequest) => void): void;
  goto(url: string, opts?: { waitUntil?: "load"; timeout?: number }): Promise<PlaywrightResponse | null>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: { path?: string; fullPage?: boolean; timeout?: number }): Promise<unknown>;
  evaluate<Arg, R>(fn: (arg: Arg) => R, arg: Arg): Promise<R>;
  click(selector: string, opts?: ActionOptions): Promise<void>;
  fill(selector: string, value: string, opts?: ActionOptions): Promise<void>;
  selectOption(
    selector: string,
    values: string | { label: string } | Array<string | { label: string }>,
    opts?: ActionOptions,
  ): Promise<string[]>;
  press(selector: string, key: string, opts?: ActionOptions): Promise<void>;
  waitForSelector(
    selector: string,
    opts?: ActionOptions & { state?: "attached" | "visible" | "hidden" },
  ): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
};
export type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
};
export type PlaywrightBrowser = {
  newContext(opts?: unknown): Promise<PlaywrightContext>;
  close(): Promise<void>;
  /** The spawned browser child process (chromium.launch always has one). */
  process?(): { kill(signal?: NodeJS.Signals | number): boolean } | null;
};
export type PlaywrightModule = {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser> };
};

/** Dynamically import Playwright; a missing module becomes an actionable ToolError. */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  const specifier = playwrightSpecifier();
  try {
    return (await import(specifier)) as PlaywrightModule;
  } catch {
    throw new ToolError("browser_unavailable", INSTALL_HINT);
  }
}
