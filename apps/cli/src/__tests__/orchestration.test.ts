import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerOrchestrationCommands } from "../register-orchestration.js";

describe("orchestration CLI", () => {
  it("registers reporting and explicit proposal review", () => {
    const program = new Command();
    registerOrchestrationCommands(program);
    const orchestration = program.commands.find((command) => command.name() === "orchestration");
    expect(orchestration?.commands.map((command) => command.name())).toEqual([
      "report",
      "proposals",
      "policy",
      "index",
      "rollout",
      "maintain",
    ]);
    expect(
      orchestration?.commands.find((command) => command.name() === "report")?.options.map((item) => item.long),
    ).toEqual(expect.arrayContaining(["--max-p95-ms", "--max-cost", "--max-failure-rate", "--min-coverage"]));
    expect(
      orchestration?.commands.find((command) => command.name() === "proposals")?.options.map((item) => item.long),
    ).toContain("--expected-updated-at");
  });

  it("rejects non-decimal SLO values", () => {
    const program = new Command().exitOverride();
    registerOrchestrationCommands(program);
    expect(() => program.parse(["node", "seekforge", "orchestration", "report", "--max-cost", "0x10"])).toThrow(
      /positive number/,
    );
  });

  it("rejects report and policy windows outside their public bounds", () => {
    const program = new Command().exitOverride();
    registerOrchestrationCommands(program);
    expect(() => program.parse(["node", "seekforge", "orchestration", "report", "--limit", "0"])).toThrow(/1 to 100/);
    expect(() =>
      program.parse(["node", "seekforge", "orchestration", "policy", "set", "--evaluation-window", "1001"]),
    ).toThrow(/1 to 1000/);
  });

  it("rejects options outside the selected lifecycle operation", () => {
    const program = new Command().exitOverride();
    registerOrchestrationCommands(program);
    expect(() => program.parse(["node", "seekforge", "orchestration", "proposals", "list", "opt-123"])).toThrow(
      /does not accept a proposal id/,
    );
    expect(() =>
      program.parse(["node", "seekforge", "orchestration", "proposals", "refresh", "--auto-rollback"]),
    ).toThrow(/only for observe/);
    expect(() => program.parse(["node", "seekforge", "orchestration", "policy", "show", "--max-cost", "1"])).toThrow(
      /does not accept update options/,
    );
    expect(() =>
      program.parse(["node", "seekforge", "orchestration", "rollout", "start", "opt-123", "--min-samples", "33"]),
    ).toThrow(/1 to 32/);
    expect(() => program.parse(["node", "seekforge", "orchestration", "rollout", "list", "--auto-rollback"])).toThrow(
      /only for reconcile/,
    );
  });
});
