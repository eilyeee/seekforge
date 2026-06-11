import { homedir } from "node:os";
import { join } from "node:path";
import { importExternalAgent, loadAgentDefinitions } from "@seekforge/core";

export function agentListCommand(): void {
  const agents = loadAgentDefinitions(process.cwd());
  if (agents.length === 0) {
    console.log("No agents available. Import one with `seekforge agent import <path>`.");
    return;
  }
  for (const a of agents) {
    console.log(`${a.id}  [${a.scope}] [${a.mode}]  ${a.description}`);
  }
}

export function agentShowCommand(id: string): void {
  const def = loadAgentDefinitions(process.cwd()).find((a) => a.id === id);
  if (!def) {
    console.error(`Agent "${id}" not found. See \`seekforge agent list\`.`);
    process.exitCode = 1;
    return;
  }
  console.log(`# ${def.name} [${def.scope}] [${def.mode}]`);
  if (def.description) console.log(`description: ${def.description}`);
  if (def.triggers.length > 0) console.log(`triggers:    ${def.triggers.join(", ")}`);
  console.log(`tools:       ${def.tools ? def.tools.join(", ") : "(all tools)"}`);
  if (def.model) console.log(`model:       ${def.model}`);
  if (def.own) console.log(`own:         ${def.own}`);
  if (def.doNotTouch) console.log(`do not touch: ${def.doNotTouch}`);
  if (def.boundary) console.log(`boundary:    ${def.boundary}`);
  if (def.maxTurns !== undefined) console.log(`max turns:   ${def.maxTurns}`);
  if (def.body) {
    console.log("");
    console.log(def.body);
  }
}

export function agentImportCommand(
  sourcePath: string,
  opts: { global?: boolean; force?: boolean },
): void {
  const targetRoot = opts.global
    ? join(homedir(), ".seekforge", "agents")
    : join(process.cwd(), ".seekforge", "agents");
  try {
    const { dir, agent, droppedTools } = importExternalAgent(sourcePath, {
      targetRoot,
      force: opts.force,
    });
    console.log(`imported "${agent.id}" [${agent.mode}] → ${dir}`);
    if (agent.tools) console.log(`tools: ${agent.tools.join(", ")}`);
    if (droppedTools.length > 0) {
      console.log(`dropped tools (no SeekForge equivalent): ${droppedTools.join(", ")}`);
    }
    console.log(`Check it with \`seekforge agent show ${agent.id}\`. The main agent can now`);
    console.log("delegate to it via dispatch_agent; edit-mode dispatch still asks for approval.");
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
