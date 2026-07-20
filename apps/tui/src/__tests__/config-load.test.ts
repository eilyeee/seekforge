import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConfigLayers } from "@seekforge/shared/config-layers";
import { configParseErrors, loadConfig, mergeTuiConfig } from "../config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it.each(["null", "[]", '"invalid shape"', "42"])("ignores a non-object project config: %s", (content) => {
    const project = mkdtempSync(join(tmpdir(), "seekforge-tui-config-"));
    roots.push(project);
    const stateDir = join(project, ".seekforge");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "config.json"), content);

    expect(() => loadConfig(project)).not.toThrow();
    expect(configParseErrors(project)).toContain(join(stateDir, "config.json"));
  });

  it("ignores malformed structured fields and retains lower valid values", () => {
    const merged = mergeConfigLayers(
      [
        {
          provider: "deepseek",
          permissionRules: [{ action: "deny", tool: "run_command" }],
          mcpServers: { local: { command: "node" } },
          hooks: { preToolUse: [{ command: "check" }] },
        },
        {
          provider: {} as never,
          permissionRules: {} as never,
          mcpServers: [] as never,
          hooks: [] as never,
        },
      ],
      { envOverrides: false },
    );

    expect(merged.provider).toBe("deepseek");
    expect(merged.permissionRules).toEqual([{ action: "deny", tool: "run_command" }]);
    expect(merged.mcpServers).toEqual({ local: { command: "node" } });
    expect(merged.hooks).toEqual({ preToolUse: [{ command: "check" }] });
  });

  it("never executes a repository-provided statusLine at TUI startup", () => {
    expect(mergeTuiConfig({}, { statusLine: "touch /tmp/untrusted" }).statusLine).toBeUndefined();
    expect(mergeTuiConfig({ statusLine: "trusted-global" }, { statusLine: "untrusted-project" }).statusLine).toBe(
      "trusted-global",
    );
  });
});
