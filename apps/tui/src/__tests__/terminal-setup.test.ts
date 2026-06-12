import { describe, expect, it } from "vitest";
import { detectTerminal, terminalSetupInstructions } from "../terminal-setup.js";

describe("detectTerminal", () => {
  it("maps TERM_PROGRAM values", () => {
    expect(detectTerminal({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
    expect(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe("apple-terminal");
    expect(detectTerminal({ TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(detectTerminal({ TERM_PROGRAM: "WezTerm" })).toBe("unknown");
    expect(detectTerminal({})).toBe("unknown");
  });
});

describe("terminalSetupInstructions", () => {
  it("returns non-empty instructions for every terminal", () => {
    for (const t of ["iterm2", "apple-terminal", "vscode", "unknown"] as const) {
      const lines = terminalSetupInstructions(t);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.length > 0)).toBe(true);
    }
  });

  it("iterm2 mentions Key Bindings and the built-in fallbacks", () => {
    const lines = terminalSetupInstructions("iterm2").join("\n");
    expect(lines).toContain("Key Bindings");
    expect(lines).toContain("Send Text");
    expect(lines).toContain("Ctrl+J");
  });

  it("vscode includes the keybindings.json snippet verbatim", () => {
    const lines = terminalSetupInstructions("vscode");
    expect(lines).toContain('    "command": "workbench.action.terminal.sendSequence",');
    expect(lines.join("\n")).toContain('"key": "shift+enter"');
  });

  it("apple-terminal points at the fallbacks", () => {
    const lines = terminalSetupInstructions("apple-terminal").join("\n");
    expect(lines).toContain("does not support");
    expect(lines).toContain("Ctrl+J");
  });
});
