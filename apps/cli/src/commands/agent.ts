import { homedir } from "node:os";
import { join } from "node:path";
import { importExternalAgent, loadAgentDefinitions } from "@seekforge/core";
import { t } from "../i18n.js";

export function agentListCommand(): void {
  const agents = loadAgentDefinitions(process.cwd());
  if (agents.length === 0) {
    console.log(t("cmd.agent.none"));
    return;
  }
  for (const a of agents) {
    console.log(t("cmd.agent.listLine", { id: a.id, scope: a.scope, mode: a.mode, description: a.description }));
  }
}

export function agentShowCommand(id: string): void {
  const def = loadAgentDefinitions(process.cwd()).find((a) => a.id === id);
  if (!def) {
    console.error(t("err.agentNotFound", { id }));
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
    console.log(t("cmd.agent.imported", { id: agent.id, mode: agent.mode, dir }));
    if (agent.tools) console.log(t("cmd.agent.tools", { tools: agent.tools.join(", ") }));
    if (droppedTools.length > 0) {
      console.log(t("cmd.agent.droppedTools", { tools: droppedTools.join(", ") }));
    }
    console.log(t("cmd.agent.importedMore", { id: agent.id }));
    console.log(t("cmd.agent.importedMore2"));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
