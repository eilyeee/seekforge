import type { Command } from "commander";
import {
  evolveAcceptCommand,
  evolveAnalyzeCommand,
  evolveApplyCommand,
  evolveListCommand,
  evolveRejectCommand,
  evolveShowCommand,
} from "./evolve.js";

export function registerEvolutionCommands(program: Command): void {
  const evolve = program
    .command("evolve")
    .description("score sessions and review self-evolution proposals (human-gated)");
  evolve
    .command("analyze")
    .argument("[session-id]", "session to analyze (default: most recent completed/failed)")
    .description("score a session, write its reflection, and generate proposals")
    .action(async (sessionId?: string) => {
      await evolveAnalyzeCommand(sessionId);
    });
  evolve
    .command("list", { isDefault: true })
    .description("list evolution proposals (pending first)")
    .action(() => {
      evolveListCommand();
    });
  evolve
    .command("show")
    .argument("<proposal-id>")
    .description("print a proposal including the exact content to be applied")
    .action((id: string) => {
      evolveShowCommand(id);
    });
  evolve
    .command("accept")
    .argument("<proposal-id>")
    .description("accept a pending proposal (apply it separately)")
    .action((id: string) => {
      evolveAcceptCommand(id);
    });
  evolve
    .command("reject")
    .argument("<proposal-id>")
    .description("reject a pending proposal")
    .action((id: string) => {
      evolveRejectCommand(id);
    });
  evolve
    .command("apply")
    .argument("<proposal-id>")
    .description("apply an accepted proposal to AGENTS.md / project.md / skills")
    .action((id: string) => {
      evolveApplyCommand(id);
    });
}
