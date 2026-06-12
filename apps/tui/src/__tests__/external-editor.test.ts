import { describe, expect, it } from "vitest";
import { parseEditorCommand } from "../external-editor.js";

describe("parseEditorCommand", () => {
  it("returns a bare command as a single part", () => {
    expect(parseEditorCommand("vi")).toEqual(["vi"]);
  });

  it("splits flags out of the env value", () => {
    expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(parseEditorCommand("emacsclient -t -a ''")).toEqual(["emacsclient", "-t", "-a", "''"]);
  });

  it("trims surrounding and collapses inner whitespace", () => {
    expect(parseEditorCommand("  nvim   -u NONE ")).toEqual(["nvim", "-u", "NONE"]);
  });

  it("returns an empty array for a blank value", () => {
    expect(parseEditorCommand("   ")).toEqual([]);
  });
});
