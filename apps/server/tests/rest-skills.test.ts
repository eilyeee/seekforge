import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-skills";

let workspace: string;
let server: RunningServer;
let base: string;
let home: string;
let savedHome: string | undefined;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

// Response.json() is typed `unknown` in this project; mirror rest.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(r: Response | Promise<Response>): Promise<any> {
  return (await r).json();
}

beforeAll(async () => {
  savedHome = process.env.SEEKFORGE_HOME;
  home = makeWorkspace();
  process.env.SEEKFORGE_HOME = home;
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["SEEKFORGE_RUNTIME_BIN"];
  workspace = makeWorkspace();
  // A project skill we can flip enabled/disabled.
  writeFileIn(
    workspace,
    ".seekforge/skills/demo-skill/skill.json",
    JSON.stringify({
      id: "demo-skill",
      name: "Demo",
      description: "",
      tags: [],
      triggers: [],
      priority: 50,
      enabled: true,
      risk: "medium",
    }),
  );
  writeFileIn(workspace, ".seekforge/skills/demo-skill/SKILL.md", "# Demo\nbody\n");
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (savedHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = savedHome;
});

describe("skill management", () => {
  it("exposes effectiveness stats and repairs legacy metadata", async () => {
    let res = await authed("/api/skills/stats");
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ stats: [] });

    res = await authed("/api/skills/repair", { method: "POST", body: JSON.stringify({ id: "demo-skill" }) });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).repaired).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(workspace, ".seekforge/skills/demo-skill/skill.json"), "utf8")).apiVersion,
    ).toBe(1);
  });

  it("PUT /api/skills/:id disables then re-enables a project skill", async () => {
    let res = await authed("/api/skills/demo-skill", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    let body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);

    const jsonPath = join(workspace, ".seekforge/skills/demo-skill/skill.json");
    expect(JSON.parse(readFileSync(jsonPath, "utf8")).enabled).toBe(false);

    res = await authed("/api/skills/demo-skill", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
    body = await jsonOf(res);
    expect(body.enabled).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, "utf8")).enabled).toBe(true);
  });

  it("PUT /api/skills/:id rejects mutating a builtin with 400", async () => {
    const res = await authed("/api/skills/bugfix", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.code).toBe("bad_request");
  });

  it("POST /api/skills scaffolds a new project skill", async () => {
    const res = await authed("/api/skills", {
      method: "POST",
      body: JSON.stringify({ id: "fresh-skill" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(existsSync(join(workspace, ".seekforge/skills/fresh-skill/skill.json"))).toBe(true);
    expect(existsSync(join(workspace, ".seekforge/skills/fresh-skill/SKILL.md"))).toBe(true);
  });

  it("POST /api/skills rejects creating over an existing skill", async () => {
    const res = await authed("/api/skills", {
      method: "POST",
      body: JSON.stringify({ id: "demo-skill" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/skills/:id removes a project skill but refuses a builtin", async () => {
    const ok = await authed("/api/skills/fresh-skill", { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).ok).toBe(true);
    expect(existsSync(join(workspace, ".seekforge/skills/fresh-skill"))).toBe(false);

    const builtin = await authed("/api/skills/bugfix", { method: "DELETE" });
    expect(builtin.status).toBe(400);
  });
});

describe("plugin management", () => {
  it("scaffolds, installs disabled, enables by digest, and removes a plugin", async () => {
    let res = await authed("/api/plugins", { method: "POST", body: JSON.stringify({ id: "rest-plugin" }) });
    expect(res.status).toBe(201);
    const created = await jsonOf(res);

    res = await authed("/api/plugins/install", {
      method: "POST",
      body: JSON.stringify({ path: created.path }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).manifest.id).toBe("rest-plugin");

    let plugins = await jsonOf(authed("/api/plugins"));
    expect(plugins.find((plugin: { scope: string }) => plugin.scope === "global").status).toBe("disabled");

    res = await authed("/api/plugins/rest-plugin", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(res.status).toBe(200);
    plugins = await jsonOf(authed("/api/plugins"));
    expect(plugins.find((plugin: { scope: string }) => plugin.scope === "global").status).toBe("enabled");

    res = await authed("/api/plugins/rest-plugin", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(home, ".seekforge/plugins/rest-plugin"))).toBe(false);
  });
});
