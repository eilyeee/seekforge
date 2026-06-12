import { describe, expect, it } from "vitest";
import { buildNotifyCommand } from "../notify.js";

describe("buildNotifyCommand", () => {
  it("builds an osascript display-notification command on darwin", () => {
    expect(buildNotifyCommand("darwin", "SeekForge", "run finished")).toEqual({
      bin: "osascript",
      args: ["-e", 'display notification "run finished" with title "SeekForge"'],
    });
  });

  it("escapes double quotes and backslashes in title and body on darwin", () => {
    const cmd = buildNotifyCommand("darwin", 'say "hi"', 'path C:\\tmp and "quotes"');
    expect(cmd).not.toBeNull();
    expect(cmd?.args).toEqual([
      "-e",
      'display notification "path C:\\\\tmp and \\"quotes\\"" with title "say \\"hi\\""',
    ]);
  });

  it("builds a notify-send command on linux with raw args", () => {
    expect(buildNotifyCommand("linux", "SeekForge", 'needs "permission"')).toEqual({
      bin: "notify-send",
      args: ["SeekForge", 'needs "permission"'],
    });
  });

  it("returns null on platforms without a known notifier", () => {
    expect(buildNotifyCommand("win32", "t", "b")).toBeNull();
    expect(buildNotifyCommand("freebsd", "t", "b")).toBeNull();
  });
});
