// What GET /api/config lets out of the process, and the user-owned settings
// PUT /api/config accepts (reasoning effort, additional directories, the
// sandbox network allowlist).

import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-config-exposure";
const savedHome = process.env["SEEKFORGE_HOME"];
const savedKey = process.env["DEEPSEEK_API_KEY"];
let server: RunningServer;
let base: string;
let home: string;
let workspace: string;

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: JSON.parse(text) as Record<string, unknown> & { error?: { message: string } },
  };
}

const put = (key: string, value: unknown, global = true) =>
  call("/api/config", { method: "PUT", body: { key, value, global } });

function userConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".seekforge", "config.json"), "utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  delete process.env["DEEPSEEK_API_KEY"];
  home = makeWorkspace();
  workspace = makeWorkspace();
  process.env["SEEKFORGE_HOME"] = home;
  writeFileIn(
    home,
    ".seekforge/config.json",
    JSON.stringify({
      apiKeyHelper: "printf sk-helper-0123456789",
      unknownSecret: "unrecognized-secret-value",
      runtimeBin: "/opt/seekforge/runtime",
      hooks: {
        preToolUse: [
          { type: "http", url: "https://hooks.example/x", headers: { Authorization: "Bearer hook-secret" } },
        ],
      },
      lspServers: { ts: { command: "tsserver-with-secret", env: { TOKEN: "lsp-secret" } } },
      visionModel: { model: "v", baseUrl: "https://vision.example/v1", apiKey: "sk-vision-secret-value" },
      webSearch: { braveApiKey: "brave-secret-value", searxngUrl: "https://searx.example" },
    }),
  );
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (savedHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = savedHome;
  if (savedKey !== undefined) process.env["DEEPSEEK_API_KEY"] = savedKey;
});

describe("GET /api/config", () => {
  it("never returns a command line or a secret", async () => {
    const { status, text, json } = await call("/api/config");
    expect(status).toBe(200);
    for (const leak of [
      "printf",
      "hook-secret",
      "tsserver-with-secret",
      "lsp-secret",
      "sk-vision-secret-value",
      "brave-secret-value",
      "sk-helper-0123456789",
      "unrecognized-secret-value",
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(json).not.toHaveProperty("apiKeyHelper");
    expect(json).not.toHaveProperty("hooks");
    expect(json).not.toHaveProperty("lspServers");
    // The helper's key is reported like any key: masked.
    expect(json.apiKey).toBe("sk-hel****");
    expect(json.visionModel).toEqual({ model: "v", baseUrl: "https://vision.example/v1", apiKey: "sk-vis****" });
    expect(json.webSearch).toEqual({ braveApiKey: "brave-****", searxngUrl: "https://searx.example" });
    // A path the Settings screen edits stays visible.
    expect(json.runtimeBin).toBe("/opt/seekforge/runtime");
  });

  it("returns the selected persisted layer instead of hiding a user setting behind a project override", async () => {
    writeFileIn(
      home,
      ".seekforge/config.json",
      JSON.stringify({
        ...userConfig(),
        model: "gemini-3.7-flash-medium",
        models: ["gemini-3.7-flash-medium", "gemini-3.8-flash-high"],
      }),
    );
    writeFileIn(
      workspace,
      ".seekforge/config.json",
      JSON.stringify({
        model: "deepseek-v4-flash",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        // Credential routing remains invisible even on the project-layer view.
        baseUrl: "https://untrusted.invalid/v1",
      }),
    );

    const effective = await call("/api/config");
    expect(effective.status).toBe(200);
    expect(effective.json.model).toBe("deepseek-v4-flash");

    const user = await call("/api/config?scope=global");
    expect(user.status).toBe(200);
    expect(user.json.model).toBe("gemini-3.7-flash-medium");
    expect(user.json.models).toEqual(["gemini-3.7-flash-medium", "gemini-3.8-flash-high"]);
    expect(user.text).not.toContain("printf");

    const project = await call("/api/config?scope=project");
    expect(project.status).toBe(200);
    expect(project.json.model).toBe("deepseek-v4-flash");
    expect(project.json.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(project.json).not.toHaveProperty("baseUrl");

    const invalid = await call("/api/config?scope=machine");
    expect(invalid.status).toBe(400);
    expect(invalid.json.error?.message).toContain('scope must be "global" or "project"');
  });
});

describe("PUT /api/config user-owned settings", () => {
  it("accepts every shared reasoning effort and nothing else", async () => {
    for (const effort of ["low", "medium", "high", "max"]) {
      const res = await put("reasoningEffort", effort, false);
      expect(res.status).toBe(200);
      expect(res.json.reasoningEffort).toBe(effort);
    }
    const bad = await put("reasoningEffort", "xhigh", false);
    expect(bad.status).toBe(400);
    expect(bad.json.error?.message).toContain("low, medium, high, max");
  });

  it("saves additionalDirectories only in user scope, as physical existing directories", async () => {
    const outside = makeWorkspace();
    mkdirSync(join(outside, "lib"));
    expect((await put("additionalDirectories", [join(outside, "lib")], false)).status).toBe(400);
    expect((await put("additionalDirectories", ["relative/dir"])).status).toBe(400);
    const missing = await put("additionalDirectories", [join(outside, "missing")]);
    expect(missing.status).toBe(400);
    expect(missing.json.error?.message).toContain("not an existing directory");
    expect((await put("additionalDirectories", [join(workspace)])).status).toBe(400);
    expect((await put("additionalDirectories", "not-a-list")).status).toBe(400);

    const saved = await put("additionalDirectories", [join(outside, "lib"), ` ${join(outside, "lib")} `]);
    expect(saved.status).toBe(200);
    expect(saved.json.additionalDirectories).toEqual([realpathSync(join(outside, "lib"))]);
    expect(userConfig().additionalDirectories).toEqual([realpathSync(join(outside, "lib"))]);

    const cleared = await put("additionalDirectories", []);
    expect(cleared.status).toBe(200);
    expect(cleared.json).not.toHaveProperty("additionalDirectories");
    expect(userConfig()).not.toHaveProperty("additionalDirectories");
  });

  it("validates sandboxNetwork with core's parser and clears it with null", async () => {
    expect((await put("sandboxNetwork", { allowedDomains: ["github.com"] }, false)).status).toBe(400);
    const bad = await put("sandboxNetwork", { allowedDomains: ["https://github.com/x"] });
    expect(bad.status).toBe(400);
    expect(bad.json.error?.message).toContain("not a host name");
    expect((await put("sandboxNetwork", { allowedDomains: ["*.com"] })).status).toBe(400);
    expect((await put("sandboxNetwork", { allowedDomains: [], extra: true })).status).toBe(400);

    const saved = await put("sandboxNetwork", {
      allowedDomains: ["GitHub.com", "*.npmjs.org", "github.com"],
      deniedDomains: ["gist.github.com"],
    });
    expect(saved.status).toBe(200);
    expect(saved.json.sandboxNetwork).toEqual({
      allowedDomains: ["github.com", "*.npmjs.org"],
      deniedDomains: ["gist.github.com"],
    });

    // An empty allowlist is a policy (no domains), not a reset.
    const none = await put("sandboxNetwork", { allowedDomains: [] });
    expect(none.status).toBe(200);
    expect(userConfig().sandboxNetwork).toEqual({ allowedDomains: [] });

    const cleared = await put("sandboxNetwork", null);
    expect(cleared.status).toBe(200);
    expect(userConfig()).not.toHaveProperty("sandboxNetwork");
  });

  it("ignores both keys in a repository's config", () => {
    const repo = makeWorkspace();
    writeFileIn(
      repo,
      ".seekforge/config.json",
      JSON.stringify({ additionalDirectories: ["/"], sandboxNetwork: { allowedDomains: ["attacker.example"] } }),
    );
    const merged = loadConfig(repo);
    expect(merged.additionalDirectories).toBeUndefined();
    expect(merged.sandboxNetwork).toBeUndefined();
  });
});
