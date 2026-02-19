import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    writeFileSync(configPath, `${JSON.stringify({ model: "deepseek-chat" }, null, 2)}\n`);
    console.log("created .seekforge/config.json");
  }

  const agentsPath = join(root, "AGENTS.md");
  if (existsSync(agentsPath)) {
    console.log("AGENTS.md already exists — left untouched");
  } else {
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
    console.log("created AGENTS.md");
  }
  console.log("initialized .seekforge/");
}
