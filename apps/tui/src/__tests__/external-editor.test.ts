import { describe, expect, it } from "vitest";
import { parseEditorCommand } from "../external-editor.js";

describe("parseEditorCommand", () => {
  it("returns a bare command as a single part", () => {
    expect(parseEditorCommand("vi")).toEqual(["vi"]);
  });

  it("splits flags out of the env value", () => {
    expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(parseEditorCommand("emacsclient -t -a ''")).toEqual(["emacsclient", "-t", "-a", ""]);
  });

  it("preserves quoted and escaped arguments without a shell", () => {
    expect(parseEditorCommand("'/Applications/Visual Studio Code.app/Contents/MacOS/Electron' --wait")).toEqual([
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "--wait",
    ]);
    expect(parseEditorCommand('code --profile "Work Profile" path\\ with\\ spaces')).toEqual([
      "code",
      "--profile",
      "Work Profile",
      "path with spaces",
    ]);
  });

  it("trims surrounding and collapses inner whitespace", () => {
    expect(parseEditorCommand("  nvim   -u NONE ")).toEqual(["nvim", "-u", "NONE"]);
  });

  it("returns an empty array for a blank value", () => {
    expect(parseEditorCommand("   ")).toEqual([]);
  });

  it("rejects malformed quoting and escaping", () => {
    expect(() => parseEditorCommand('code "unfinished')).toThrow("unterminated quote");
    expect(() => parseEditorCommand("code \\")).toThrow("ends with an escape");
  });
});
