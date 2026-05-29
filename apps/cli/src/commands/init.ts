import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL } from "@seekforge/core";
import { t } from "../i18n.js";

const AGENTS_TEMPLATE = `# AGENTS.md

## Project Overview

Describe this project here.

## Tech Stack

- Language:
- Framework:
- Package manager:
- Test framework:

## Commands

- Install:
- Test:
- Lint:
- Build:

## Agent Rules

- Always inspect relevant files before editing.
- Run the most relevant verification command after changes.
- Do not modify .env files.
`;

export function initCommand(): void {
  const root = process.cwd();
  const dir = join(root, ".seekforge");
  for (const sub of ["sessions", "memory", "skills"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    // 0600: users often put apiKey in here later.
    writeFileSync(configPath, `${JSON.stringify({ model: DEFAULT_MODEL }, null, 2)}\n`, { mode: 0o600 });
    console.log(t("cmd.init.createdConfig"));
  }

  const agentsPath = join(root, "AGENTS.md");
  if (existsSync(agentsPath)) {
    console.log(t("cmd.init.agentsExists"));
  } else {
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
    console.log(t("cmd.init.createdAgents"));
  }
  console.log(t("cmd.init.initialized"));
}
