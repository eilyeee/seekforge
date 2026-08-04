import type React from "react";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { render } from "ink";
import {
  buildProvider,
  configureBrowserProfile,
  configureVision,
  resolveBrowserProfilePath,
  createMcpElicitationHandler,
  createMcpSamplingHandler,
  createUsageBus,
  listSessions,
} from "@seekforge/core";
import { App } from "./app.js";
import { loadConfig, type TuiConfig } from "./config.js";
import { prepareMcp } from "./agent/factory.js";
import { createInteractiveChannelHolder } from "./agent/interactive-channels.js";
import { loadTheme } from "./theme.js";
import { detectLocale, setLocale } from "./strings.js";
import { setAccent } from "./components/Header.js";
import { parseTuiArgs, TUI_HELP } from "./cli-args.js";
import { needsOnboarding, saveGlobalApiKey } from "./onboarding.js";
import { Onboarding } from "./components/Onboarding.js";
import { checkForUpdate, formatUpdateNotice } from "../../cli/src/version-check.js";

/** First-run wizard: collect the API key, save it globally, return it. */
async function runOnboarding(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const instance = render(
      <Onboarding
        onDone={(apiKey) => {
          try {
            saveGlobalApiKey(apiKey);
            instance.unmount();
            resolve(apiKey);
          } catch (error) {
            instance.unmount();
            reject(error);
          }
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
  setLocale(config.locale ?? detectLocale());
  configureVision(
    config.visionModel?.baseUrl
      ? {
          model: config.visionModel.model,
          baseUrl: config.visionModel.baseUrl,
          ...(config.visionModel.apiKey ? { apiKey: config.visionModel.apiKey } : {}),
        }
      : null,
  );
  // Browser-session persistence, off unless the user named a profile. Resolved
  // once here, so an invalid name is a startup error the user sees rather than
  // a tool failure three prompts into a run.
  try {
    configureBrowserProfile(config.browserProfile ? resolveBrowserProfilePath(homedir(), config.browserProfile) : null);
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

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
  // MCP servers live for the whole session, so they are started before the app
  // renders. A server may still ask to run a model call or put a question to
  // the user; both go through the run that is active when it asks.
  const channels = createInteractiveChannelHolder();
  const usageBus = createUsageBus();
  const mcp = await prepareMcp(config, projectPath, {
    ...(config.apiKey
      ? {
          sampling: createMcpSamplingHandler({
            provider: () =>
              buildProvider(
                {
                  provider: config.provider,
                  apiKey: config.apiKey,
                  baseUrl: config.baseUrl,
                  modelPricing: config.modelPricing,
                },
                config.model,
              ),
            confirm: (request) => channels.confirm(request),
            onUsage: (usage) => usageBus.record(usage),
          }),
        }
      : {}),
    elicitation: createMcpElicitationHandler({ askUser: (question) => channels.askUser(question) }),
  });
  const continueSessionId = args.continueLast ? listSessions(projectPath)[0]?.id : undefined;

  let version: string | undefined;
  try {
    const require = createRequire(import.meta.url);
    version = (require("../package.json") as { version?: string }).version;
  } catch {
    // header simply omits the version
  }

  const appTree = (extra?: { updateNotice?: string }): React.ReactElement => (
    <App
      config={config}
      projectPath={projectPath}
      initialModel={model}
      mcpToolSpecs={mcp.specs}
      mcpEntries={mcp.entries}
      channels={channels}
      usageBus={usageBus}
      pluginContributions={mcp.pluginContributions}
      {...(continueSessionId ? { initialSessionId: continueSessionId } : {})}
      {...(version ? { version } : {})}
      {...(extra?.updateNotice ? { updateNotice: extra.updateNotice } : {})}
    />
  );

  const { waitUntilExit, rerender } = render(appTree());

  // Non-blocking npm update check: never delays render; re-renders with a dim
  // notice if a newer version is found (mostly instant via the 24h cache).
  if (version) {
    const v = version;
    void checkForUpdate(v).then((latest) => {
      if (latest) rerender(appTree({ updateNotice: formatUpdateNotice(latest, v) }));
    });
  }
  try {
    await waitUntilExit();
  } finally {
    mcp.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
