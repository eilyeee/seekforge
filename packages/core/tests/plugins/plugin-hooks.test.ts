import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginScaffold, listPlugins, mergePluginHooks } from "../../src/plugins/index.js";

const previousHome = process.env.SEEKFORGE_HOME;
const roots: string[] = [];

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function pluginWithHooks(hooks: unknown): ReturnType<typeof listPlugins>[number] | undefined {
  process.env.SEEKFORGE_HOME = temp("seekforge-plugin-hooks-home-");
  const workspace = temp("seekforge-plugin-hooks-ws-");
  const scaffold = createPluginScaffold(workspace, "hooky");
  fs.writeFileSync(
    path.join(scaffold.path, "plugin.json"),
    `${JSON.stringify({ ...scaffold.manifest, contributes: { ...scaffold.manifest.contributes, hooks } })}\n`,
  );
  return listPlugins(workspace).find((plugin) => plugin.id === "hooky");
}

describe("plugin hook schema", () => {
  it("accepts every hook type and the new stages", () => {
    const record = pluginWithHooks({
      permissionRequest: [{ type: "http", url: "https://policy.example.test/check", timeout: 5 }],
      postCompact: [{ type: "prompt", prompt: "Summarize?", model: "fast" }],
      preToolUse: [{ match: "write_file|apply_patch", command: "./gate.sh" }],
    });
    expect(record?.status).toBe("review_required");
  });

  it.each([
    [
      { preToolUse: [{ type: "http", url: "https://x.example.test", allowedEnvVars: ["AWS_SECRET_ACCESS_KEY"] }] },
      "environment variables",
    ],
    [{ preToolUse: [{ command: "x", match: "(a+)+" }] }, "refused"],
    [{ stop: [{ type: "http", url: "ftp://x.example.test" }] }, "http or https"],
    [{ stop: [{ command: "x", surprise: true }] }, ""],
    [{ beforeAll: [{ command: "x" }] }, ""],
  ])("rejects %j", (hooks, message) => {
    const record = pluginWithHooks(hooks);
    expect(record?.status).toBe("invalid");
    expect(record?.error ?? "").toContain(message);
  });

  it("merges configured hooks for every stage, including new ones", () => {
    const workspace = temp("seekforge-plugin-hooks-merge-");
    process.env.SEEKFORGE_HOME = temp("seekforge-plugin-hooks-home-");
    expect(
      mergePluginHooks(workspace, {
        postToolUseFailure: [{ command: "a" }],
        subagentStart: [{ command: "b" }],
      }),
    ).toEqual({ postToolUseFailure: [{ command: "a" }], subagentStart: [{ command: "b" }] });
  });
});
