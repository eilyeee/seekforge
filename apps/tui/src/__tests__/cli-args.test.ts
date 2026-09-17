import { describe, expect, it } from "vitest";
import { initialApprovalFor, PERMISSION_MODE_NAMES, parseTuiArgs, TUI_HELP } from "../cli-args.js";

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

  it("parses --model / -m with a separate value and --model=<name>", () => {
    expect(parseTuiArgs(["--model", "deepseek-coder"]).model).toBe("deepseek-coder");
    expect(parseTuiArgs(["-m", "deepseek-coder"]).model).toBe("deepseek-coder");
    expect(parseTuiArgs(["--model=deepseek-chat"]).model).toBe("deepseek-chat");
  });

  it("rejects a value flag without its value", () => {
    expect(parseTuiArgs(["--model"]).error).toBe("option '--model' needs a value");
    expect(parseTuiArgs(["--model", "--vim"]).error).toBe("option '--model' needs a value");
    expect(parseTuiArgs(["--model="]).error).toBe("option '--model' needs a value");
    expect(parseTuiArgs(["--resume"]).error).toBe("option '--resume' needs a value");
  });

  it("parses -h and --help", () => {
    expect(parseTuiArgs(["-h"]).help).toBe(true);
    expect(parseTuiArgs(["--help"]).help).toBe(true);
  });

  it("rejects unknown flags and stray arguments instead of ignoring them", () => {
    expect(parseTuiArgs(["--wat", "-c"]).error).toBe("unknown option '--wat'");
    expect(parseTuiArgs(["-c", "extra"]).error).toMatch(/^unexpected argument 'extra'/);
    expect(parseTuiArgs(["--vim=yes"]).error).toBe("option '--vim' takes no value");
  });

  it("parses every forwarded launch flag", () => {
    expect(
      parseTuiArgs([
        "--resume",
        "20260101T000000-abc",
        "--permission-mode",
        "acceptEdits",
        "-y",
        "--add-dir",
        "../lib",
        "--add-dir=/opt/shared",
        "--settings",
        "ci.json",
        "--profile=fast",
        "--mcp-config",
        "mcp.json",
        "--strict-mcp-config",
        "--append-system-prompt=- be terse",
        "--verbose",
      ]),
    ).toEqual({
      continueLast: false,
      help: false,
      resume: "20260101T000000-abc",
      permissionMode: "acceptEdits",
      yes: true,
      addDirs: ["../lib", "/opt/shared"],
      settings: "ci.json",
      profile: "fast",
      mcpConfig: "mcp.json",
      strictMcpConfig: true,
      appendSystemPrompt: "- be terse",
      verbose: true,
    });
  });

  it("validates the permission mode", () => {
    expect(parseTuiArgs(["--permission-mode", "yolo"]).error).toMatch(/^unknown permission mode 'yolo'/);
    for (const mode of PERMISSION_MODE_NAMES) expect(parseTuiArgs(["--permission-mode", mode]).error).toBeUndefined();
  });

  it("refuses -c together with --resume", () => {
    expect(parseTuiArgs(["-c", "--resume", "x"]).error).toMatch(/not both/);
  });
});

describe("initialApprovalFor", () => {
  it("maps Claude-compatible and native names, with --permission-mode winning over -y", () => {
    expect(initialApprovalFor(parseTuiArgs([]))).toBeUndefined();
    expect(initialApprovalFor(parseTuiArgs(["-y"]))).toBe("auto");
    expect(initialApprovalFor(parseTuiArgs(["--dangerously-skip-permissions"]))).toBe("auto");
    expect(initialApprovalFor(parseTuiArgs(["--permission-mode", "default"]))).toBe("confirm");
    expect(initialApprovalFor(parseTuiArgs(["--permission-mode", "bypassPermissions"]))).toBe("auto");
    expect(initialApprovalFor(parseTuiArgs(["--permission-mode", "plan", "-y"]))).toBe("plan");
    expect(initialApprovalFor(parseTuiArgs(["-y", "--permission-mode", "acceptEdits"]))).toBe("acceptEdits");
  });
});

describe("TUI_HELP", () => {
  it("mentions every flag", () => {
    for (const flag of [
      "--continue",
      "--resume",
      "--vim",
      "--no-vim",
      "--model",
      "--permission-mode",
      "--yes",
      "--dangerously-skip-permissions",
      "--add-dir",
      "--settings",
      "--profile",
      "--mcp-config",
      "--strict-mcp-config",
      "--append-system-prompt",
      "--verbose",
      "--help",
    ]) {
      expect(TUI_HELP).toContain(flag);
    }
  });
});
