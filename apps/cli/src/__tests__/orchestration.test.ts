import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerOrchestrationCommands } from "../register-orchestration.js";

describe("orchestration CLI", () => {
  it("registers reporting and explicit proposal review", () => {
    const program = new Command();
    registerOrchestrationCommands(program);
    const orchestration = program.commands.find((command) => command.name() === "orchestration");
    expect(orchestration?.commands.map((command) => command.name())).toEqual(["report", "proposals"]);
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
});
