import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { loadConfig } from "./config.js";
import { prepareMcp } from "./agent/factory.js";

async function main(): Promise<void> {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);

  // The TUI is interactive only. Without a TTY (CI, piped stdout, smoke import)
  // there is nothing to render — print a short notice and exit cleanly instead
  // of crashing Ink's raw-mode setup.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("seekforge-tui requires an interactive terminal (TTY).\n");
    return;
  }

  if (!config.apiKey) {
    process.stderr.write(
      "No DeepSeek API key found. Set DEEPSEEK_API_KEY or write ~/.seekforge/config.json with { \"apiKey\": \"…\" }.\n",
    );
    process.exitCode = 1;
    return;
  }

  const model = config.model ?? "deepseek-chat";
  const mcp = await prepareMcp(config); // MCP servers live for the whole session

  const { waitUntilExit } = render(
    <App config={config} projectPath={projectPath} initialModel={model} mcpToolSpecs={mcp.specs} />,
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
