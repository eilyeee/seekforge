import { describe, expect, it } from "vitest";
import { parseTuiArgs, TUI_HELP } from "../cli-args.js";

describe("parseTuiArgs", () => {
  it("defaults with empty argv", () => {
    expect(parseTuiArgs([])).toEqual({ continueLast: false, help: false });
  });

  it("parses -c and --continue", () => {
    expect(parseTuiArgs(["-c"]).continueLast).toBe(true);
    expect(parseTuiArgs(["--continue"]).continueLast).toBe(true);
  });

  it("parses --vim and --no-vim (last wins)", () => {
    expect(parseTuiArgs(["--vim"]).vim).toBe(true);
    expect(parseTuiArgs(["--no-vim"]).vim).toBe(false);
    expect(parseTuiArgs(["--vim", "--no-vim"]).vim).toBe(false);
    expect(parseTuiArgs([]).vim).toBeUndefined();
  });

  it("parses --model with a separate value", () => {
    expect(parseTuiArgs(["--model", "deepseek-coder"]).model).toBe("deepseek-coder");
  });

  it("parses --model=<name>", () => {
    expect(parseTuiArgs(["--model=deepseek-chat"]).model).toBe("deepseek-chat");
  });

  it("ignores --model without a value", () => {
    expect(parseTuiArgs(["--model"]).model).toBeUndefined();
    expect(parseTuiArgs(["--model", "--vim"])).toEqual({ continueLast: false, help: false, vim: true });
    expect(parseTuiArgs(["--model="]).model).toBeUndefined();
  });

  it("parses -h and --help", () => {
    expect(parseTuiArgs(["-h"]).help).toBe(true);
    expect(parseTuiArgs(["--help"]).help).toBe(true);
  });

  it("ignores unknown flags and combines known ones", () => {
    expect(parseTuiArgs(["--wat", "-c", "--model=deepseek-coder", "--vim", "extra"])).toEqual({
      continueLast: true,
      help: false,
      vim: true,
      model: "deepseek-coder",
    });
  });
});

describe("TUI_HELP", () => {
  it("mentions every flag", () => {
    for (const flag of ["--continue", "--vim", "--no-vim", "--model", "--help"]) {
      expect(TUI_HELP).toContain(flag);
    }
  });
});
