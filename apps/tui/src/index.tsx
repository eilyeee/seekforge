import React from "react";
import { createRequire } from "node:module";
import { render } from "ink";
import { listSessions } from "@seekforge/core";
import { App } from "./app.js";
import { loadConfig, type TuiConfig } from "./config.js";
import { prepareMcp } from "./agent/factory.js";
import { loadTheme } from "./theme.js";
import { setAccent } from "./components/Header.js";
import { parseTuiArgs, TUI_HELP } from "./cli-args.js";
import { needsOnboarding, saveGlobalApiKey } from "./onboarding.js";
import { Onboarding } from "./components/Onboarding.js";

/** First-run wizard: collect the API key, save it globally, return it. */
async function runOnboarding(): Promise<string | null> {
  return new Promise((resolve) => {
    const instance = render(
      <Onboarding
        onDone={(apiKey) => {
          saveGlobalApiKey(apiKey);
          instance.unmount();
          resolve(apiKey);
        }}
        onSkip={() => {
          instance.unmount();
          resolve(null);
        }}
      />,
    );
  });
}

async function main(): Promise<void> {
  const args = parseTuiArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${TUI_HELP}\n`);
    return;
  }

  const projectPath = process.cwd();
  let config: TuiConfig = loadConfig(projectPath);
  if (args.model) config = { ...config, model: args.model };
  if (args.vim !== undefined) config = { ...config, vim: args.vim };
  setAccent(loadTheme(config.accent).accent);

  // The TUI is interactive only. Without a TTY (CI, piped stdout, smoke import)
  // there is nothing to render — print a short notice and exit cleanly instead
  // of crashing Ink's raw-mode setup.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("seekforge-tui requires an interactive terminal (TTY).\n");
    return;
  }

  // First run: a key wizard instead of an error message.
  if (needsOnboarding(config)) {
    const key = await runOnboarding();
    if (key === null) {
      process.stderr.write(
        "No DeepSeek API key configured. Set DEEPSEEK_API_KEY or re-run seekforge-tui to try again.\n",
      );
      process.exitCode = 1;
      return;
    }
    config = loadConfig(projectPath); // re-load: env precedence still applies
    if (args.model) config = { ...config, model: args.model };
    if (args.vim !== undefined) config = { ...config, vim: args.vim };
  }

  const model = config.model ?? "deepseek-v4-flash";
  const mcp = await prepareMcp(config); // MCP servers live for the whole session
  const continueSessionId = args.continueLast ? listSessions(projectPath)[0]?.id : undefined;

  let version: string | undefined;
  try {
    const require = createRequire(import.meta.url);
    version = (require("../package.json") as { version?: string }).version;
  } catch {
    // header simply omits the version
  }

  const { waitUntilExit } = render(
    <App
      config={config}
      projectPath={projectPath}
      initialModel={model}
      mcpToolSpecs={mcp.specs}
      mcpEntries={mcp.entries}
      {...(continueSessionId ? { initialSessionId: continueSessionId } : {})}
      {...(version ? { version } : {})}
    />,
  );
  try {
    await waitUntilExit();
  } finally {
    mcp.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
