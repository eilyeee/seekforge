import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalMode, PermissionRequest, PermissionRule } from "@seekforge/shared";
import { createDefaultDispatcher, enforcePermission, proposeDurableRule } from "../../src/tools/index.js";
import type { ClassifiedCall } from "../../src/tools/registry.js";
import { compileRuleGlob, toolPatternMatches } from "../../src/tools/rule-match.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

type Outcome = Awaited<ReturnType<typeof enforcePermission>>;

async function decide(
  toolName: string,
  cls: ClassifiedCall,
  rules: PermissionRule[],
  options: { approvalMode?: ApprovalMode; workspace?: string; sessionAllowlist?: string[] } = {},
): Promise<{ outcome: Outcome; prompts: PermissionRequest[] }> {
  const prompts: PermissionRequest[] = [];
  const ctx = makeCtx(options.workspace ?? makeWorkspace(), {
    policy: {
      approvalMode: options.approvalMode ?? "confirm",
      rules,
      ...(options.sessionAllowlist ? { sessionAllowlist: options.sessionAllowlist } : {}),
    },
    confirm: async (req) => {
      prompts.push(req);
      return false;
    },
  });
  return { outcome: await enforcePermission(toolName, cls, ctx), prompts };
}

const run = (command: string): ClassifiedCall => ({ permission: "execute", description: command, command });
const fetchUrl = (url: string): ClassifiedCall => ({ permission: "env", description: url, command: `GET ${url}` });
const write = (p: string): ClassifiedCall => ({ permission: "write", description: p, path: p });
const read = (p: string): ClassifiedCall => ({ permission: "readonly", description: p, path: p });

describe("tool name globs", () => {
  it("matches `*` globs over tool names and keeps exact names exact", () => {
    expect(toolPatternMatches("mcp__github__*", "mcp__github__create_issue")).toBe(true);
    expect(toolPatternMatches("mcp__github__*", "mcp__gitlab__create_issue")).toBe(false);
    expect(toolPatternMatches("browser_*", "browser_click")).toBe(true);
    expect(toolPatternMatches("*", "anything")).toBe(true);
    expect(toolPatternMatches("run", "run_command")).toBe(false);
    expect(toolPatternMatches("run.command", "run_command")).toBe(false);
  });

  it("applies a glob allow rule to an env-level MCP tool and a glob deny to read-only tools", async () => {
    const mcp: ClassifiedCall = { permission: "env", description: "mcp", command: "mcp:github/create_issue" };
    const allowed = await decide("mcp__github__create_issue", mcp, [{ action: "allow", tool: "mcp__github__*" }]);
    expect(allowed.outcome).toMatchObject({ allowed: true, decision: "allow_rule" });
    const other = await decide("mcp__gitlab__create_issue", mcp, [{ action: "allow", tool: "mcp__github__*" }]);
    expect(other.prompts).toHaveLength(1);
    const denied = await decide("browser_snapshot", read("."), [{ action: "deny", tool: "browser_*" }]);
    expect(denied.outcome).toMatchObject({ allowed: false, decision: "deny_rule" });
  });
});

describe("command wildcards", () => {
  const allowNpmRun: PermissionRule[] = [{ action: "allow", tool: "run_command", match: "npm run *" }];

  it("an allow wildcard is anchored, whitespace-normalized, and covers the bare command", async () => {
    for (const command of ["npm run build", "npm   run  build --watch", "npm run"]) {
      const { outcome } = await decide("run_command", run(command), allowNpmRun);
      expect(outcome, command).toMatchObject({ allowed: true, decision: "allow_rule" });
    }
    for (const command of ["npm runx", "npx npm run build", "npm run-script build"]) {
      const { prompts } = await decide("run_command", run(command), allowNpmRun);
      expect(prompts, command).toHaveLength(1);
    }
  });

  it("an allow wildcard never matches a compound command", async () => {
    for (const command of [
      "npm run build && touch x",
      "npm run build; touch x",
      "npm run $(touch x)",
      "npm run build\ntouch x",
    ]) {
      const { prompts } = await decide("run_command", run(command), allowNpmRun);
      expect(prompts, command).toHaveLength(1);
    }
  });

  it("an allow rule must name its program: a wildcard first word matches nothing", async () => {
    const { prompts } = await decide("run_command", run("node --version"), [
      { action: "allow", tool: "run_command", match: "* --version" },
    ]);
    expect(prompts).toHaveLength(1);
  });

  it("never rescues a dangerous command", async () => {
    const rules: PermissionRule[] = [{ action: "allow", tool: "run_command", match: "git push *" }];
    const env = await decide("run_command", { ...run("git push origin main"), permission: "env" }, rules);
    expect(env.outcome).toMatchObject({ allowed: true, decision: "allow_rule" });
    const forced = await decide("run_command", { ...run("git push --force"), permission: "dangerous" }, rules);
    expect(forced.outcome).toMatchObject({ allowed: false, decision: "denied_dangerous" });
  });

  it("deny and ask wildcards fail closed: sub-commands, assignments and program paths all count", async () => {
    const deny: PermissionRule[] = [{ action: "deny", tool: "run_command", match: "git push *" }];
    for (const command of [
      "git push origin",
      "git push",
      "cd sub && git push origin",
      "echo $(git push origin)",
      "GIT_TRACE=1 git push origin",
      "/usr/bin/git push origin",
    ]) {
      const { outcome } = await decide("run_command", run(command), deny, { approvalMode: "auto" });
      expect(outcome, command).toMatchObject({ allowed: false, decision: "deny_rule" });
    }
    const unrelated = await decide("run_command", run("git status"), deny, { approvalMode: "auto" });
    expect(unrelated.outcome.allowed).toBe(true);

    const ask: PermissionRule[] = [{ action: "ask", tool: "run_command", match: "npm publish*" }];
    const asked = await decide("run_command", run("npm ci && npm publish --tag next"), ask, { approvalMode: "auto" });
    expect(asked.prompts).toHaveLength(1);
  });

  it("a plain deny rule also sees each command of a compound line", async () => {
    const deny: PermissionRule[] = [{ action: "deny", tool: "run_command", match: "curl" }];
    const { outcome } = await decide("run_command", run("echo ok && curl example.com"), deny, { approvalMode: "auto" });
    expect(outcome).toMatchObject({ allowed: false, decision: "deny_rule" });
  });

  it("does not offer a durable rule that would be read back as a wildcard", () => {
    expect(proposeDurableRule("run_command", run("ls *.ts"))).toBeUndefined();
    expect(proposeDurableRule("run_command", run("ls src"))).toEqual({
      action: "allow",
      tool: "run_command",
      match: "ls src",
    });
    expect(proposeDurableRule("run_tests", run("pnpm test"))).toEqual({
      action: "allow",
      tool: "run_tests",
      match: "pnpm test",
    });
  });
});

describe("run_tests is matched as the shell command it runs", () => {
  it("applies token boundaries and refuses compound lines for allow rules", async () => {
    const rules: PermissionRule[] = [{ action: "allow", tool: "run_tests", match: "pnpm test" }];
    const ok = await decide("run_tests", run("pnpm test --run"), rules);
    expect(ok.outcome).toMatchObject({ allowed: true, decision: "allow_rule" });
    for (const command of ["pnpm test-all", "pnpm test; touch pwned"]) {
      const { prompts } = await decide("run_tests", run(command), rules);
      expect(prompts, command).toHaveLength(1);
    }
  });

  it("remembers the command for the session, not the bare tool name", async () => {
    const ws = makeWorkspace();
    const sessionAllowlist: string[] = [];
    const prompts: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm: async (req) => {
        prompts.push(req);
        return { allow: true, remember: "session" };
      },
    });
    await enforcePermission("run_tests", run("pnpm test"), ctx);
    expect(sessionAllowlist).toEqual(["pnpm test"]);
    expect((await enforcePermission("run_tests", run("pnpm test --run"), ctx)).decision).toBe("session_allowlist");
    await enforcePermission("run_tests", run("rm -r src"), ctx);
    await enforcePermission("run_tests", run("pnpm test; touch x"), ctx);
    expect(prompts).toHaveLength(3);
  });
});

describe("URL rules", () => {
  const allowDocs: PermissionRule[] = [{ action: "allow", tool: "web_fetch", match: "GET https://docs.example.com" }];

  it("a URL prefix allow compares scheme, host and path structurally", async () => {
    for (const url of ["https://docs.example.com/guide", "https://DOCS.example.com/x", "https://docs.example.com"]) {
      const { outcome } = await decide("web_fetch", fetchUrl(url), allowDocs);
      expect(outcome, url).toMatchObject({ allowed: true, decision: "allow_rule" });
    }
    for (const url of [
      "https://docs.example.com.evil.net/x",
      "https://docs.example.com@evil.net/x",
      "https://docs.example.com:8443/x",
      "http://docs.example.com/x",
      "not a url",
    ]) {
      const { prompts } = await decide("web_fetch", fetchUrl(url), allowDocs);
      expect(prompts, url).toHaveLength(1);
    }
  });

  it("a URL path prefix needs a path boundary; a host-less rule keeps its plain prefix", async () => {
    const guide: PermissionRule[] = [
      { action: "allow", tool: "web_fetch", match: "GET https://docs.example.com/guide" },
    ];
    expect((await decide("web_fetch", fetchUrl("https://docs.example.com/guide/intro"), guide)).outcome.allowed).toBe(
      true,
    );
    expect((await decide("web_fetch", fetchUrl("https://docs.example.com/guide-v2"), guide)).prompts).toHaveLength(1);
    const anyHttps: PermissionRule[] = [{ action: "allow", tool: "web_fetch", match: "GET https://" }];
    expect((await decide("web_fetch", fetchUrl("https://anything.test/x"), anyHttps)).outcome.allowed).toBe(true);
  });

  it("a domain rule covers the host and its subdomains and nothing else", async () => {
    const rules: PermissionRule[] = [{ action: "allow", tool: "web_fetch", match: "domain:example.com" }];
    expect((await decide("web_fetch", fetchUrl("https://api.example.com/v1"), rules)).outcome.allowed).toBe(true);
    expect((await decide("web_fetch", fetchUrl("http://example.com"), rules)).outcome.allowed).toBe(true);
    expect((await decide("web_fetch", fetchUrl("https://example.com.evil.net/"), rules)).prompts).toHaveLength(1);
    expect((await decide("web_fetch", fetchUrl("https://notexample.com/"), rules)).prompts).toHaveLength(1);
    const search: ClassifiedCall = { permission: "env", description: "s", command: "SEARCH example.com" };
    const any: PermissionRule[] = [{ action: "allow", tool: "*", match: "domain:example.com" }];
    expect((await decide("web_search", search, any)).prompts).toHaveLength(1);
    expect(
      (await decide("read_file", read("example.com"), [{ action: "deny", tool: "*", match: "domain:example.com" }]))
        .outcome.allowed,
    ).toBe(true);
  });

  it("deny URL and domain rules fail closed", async () => {
    const denyDomain: PermissionRule[] = [{ action: "deny", tool: "*", match: "domain:evil.net" }];
    expect((await decide("web_fetch", fetchUrl("https://x.EVIL.net/"), denyDomain)).outcome.decision).toBe("deny_rule");
    expect((await decide("browser_navigate", fetchUrl("::not a url::"), denyDomain)).outcome.decision).toBe(
      "deny_rule",
    );
    const denyPrefix: PermissionRule[] = [{ action: "deny", tool: "web_fetch", match: "GET https://evil.net" }];
    expect((await decide("web_fetch", fetchUrl("https://EVIL.net/x"), denyPrefix)).outcome.decision).toBe("deny_rule");
    expect((await decide("web_fetch", fetchUrl("https://evil.network/x"), denyPrefix)).outcome.decision).toBe(
      "deny_rule",
    );
    expect((await decide("web_fetch", fetchUrl("https://fine.net/x"), denyPrefix)).prompts).toHaveLength(1);
  });
});

describe("path rules", () => {
  it("compiles rule globs with **, * and ? only", () => {
    expect(compileRuleGlob("**/*.env").test("config/prod.env")).toBe(true);
    expect(compileRuleGlob("**/*.env").test(".env")).toBe(true);
    expect(compileRuleGlob("src/**").test("src/a/b.ts")).toBe(true);
    expect(compileRuleGlob("src/**").test("src")).toBe(false);
    expect(compileRuleGlob("docs/*.md").test("docs/sub/a.md")).toBe(false);
    expect(compileRuleGlob("a/**/b").test("a/b")).toBe(true);
    expect(compileRuleGlob("a/**/b").test("a/x/y/b")).toBe(true);
    expect(compileRuleGlob("app/[id]/*").test("app/[id]/page.tsx")).toBe(true);
    expect(compileRuleGlob("app/[id]/*").test("app/i/page.tsx")).toBe(false);
    expect(compileRuleGlob("file?.txt").test("file1.txt")).toBe(true);
  });

  it("glob allow rules authorize exactly what they say", async () => {
    const src: PermissionRule[] = [{ action: "allow", tool: "write_file", match: "src/**" }];
    expect((await decide("write_file", write("src/a/b.ts"), src)).outcome.decision).toBe("allow_rule");
    for (const p of ["src/../x.ts", "srcx/a.ts", "x.ts"]) {
      expect((await decide("write_file", write(p), src)).prompts, p).toHaveLength(1);
    }
    const docs: PermissionRule[] = [{ action: "allow", tool: "write_file", match: "docs/*.md" }];
    expect((await decide("write_file", write("./docs/a.md"), docs)).outcome.decision).toBe("allow_rule");
    expect((await decide("write_file", write("docs/sub/a.md"), docs)).prompts).toHaveLength(1);
  });

  it("glob deny rules block at any depth and cover the directory itself", async () => {
    const env: PermissionRule[] = [{ action: "deny", tool: "*", match: "**/*.env" }];
    expect((await decide("read_file", read("config/prod.env"), env)).outcome.decision).toBe("deny_rule");
    expect((await decide("read_file", read("src/../prod.env"), env)).outcome.decision).toBe("deny_rule");
    const secrets: PermissionRule[] = [{ action: "deny", tool: "*", match: "secrets/**" }];
    expect((await decide("list_files", read("secrets"), secrets)).outcome.decision).toBe("deny_rule");
  });

  it("plain rules keep prefix semantics, with brackets read literally", async () => {
    const deny: PermissionRule[] = [{ action: "deny", tool: "*", match: "app/[id]" }];
    expect((await decide("read_file", read("app/[id]/page.tsx"), deny)).outcome.decision).toBe("deny_rule");
    const allow: PermissionRule[] = [{ action: "allow", tool: "write_file", match: "src" }];
    expect((await decide("write_file", write("src/a.ts"), allow)).outcome.decision).toBe("allow_rule");
    expect((await decide("write_file", write("srcfoo/a.ts"), allow)).prompts).toHaveLength(1);
  });

  it("a deny rule cannot be bypassed with an absolute path or a symlink alias", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "secrets"));
    fs.writeFileSync(path.join(ws, "secrets", "key.txt"), "k");
    fs.symlinkSync(path.join(ws, "secrets"), path.join(ws, "alias"));
    const deny: PermissionRule[] = [{ action: "deny", tool: "*", match: "secrets" }];
    for (const p of [
      path.join(ws, "secrets", "key.txt"),
      "alias/key.txt",
      path.join(fs.realpathSync(ws), "secrets/key.txt"),
    ]) {
      const { outcome } = await decide("read_file", read(p), deny, { workspace: ws });
      expect(outcome, p).toMatchObject({ allowed: false, decision: "deny_rule" });
    }
    const absoluteRule: PermissionRule[] = [{ action: "deny", tool: "*", match: path.join(ws, "secrets") }];
    expect((await decide("read_file", read("secrets/key.txt"), absoluteRule, { workspace: ws })).outcome.decision).toBe(
      "deny_rule",
    );
  });

  it("an allow rule does not follow a symlink out of the directory it names", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "config"));
    fs.symlinkSync(path.join(ws, "config"), path.join(ws, "src", "link"));
    const allow: PermissionRule[] = [{ action: "allow", tool: "write_file", match: "src" }];
    const { prompts } = await decide("write_file", write("src/link/ci.yml"), allow, { workspace: ws });
    expect(prompts).toHaveLength(1);
    expect((await decide("write_file", write("src/real.ts"), allow, { workspace: ws })).outcome.decision).toBe(
      "allow_rule",
    );
  });
});

describe("session grants for file tools", () => {
  it("do not travel through a symlinked directory inside the approved folder", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "config"));
    fs.symlinkSync(path.join(ws, "config"), path.join(ws, "src", "link"));
    const dispatcher = createDefaultDispatcher();
    const prompts: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist: [] },
      confirm: async (req) => {
        prompts.push(req);
        return { allow: true, remember: "session" };
      },
    });
    await dispatcher.execute(call("write_file", { path: "src/a.ts", content: "a" }), ctx);
    await dispatcher.execute(call("write_file", { path: "src/b.ts", content: "b" }), ctx);
    expect(prompts).toHaveLength(1);
    await dispatcher.execute(call("write_file", { path: "src/link/ci.yml", content: "c" }), ctx);
    expect(prompts).toHaveLength(2);
  });

  it("are never recorded for an empty or unresolvable path", async () => {
    const ws = makeWorkspace();
    fs.symlinkSync(path.join(ws, "missing-target"), path.join(ws, "dangling"));
    const sessionAllowlist: string[] = [];
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm: async () => ({ allow: true, remember: "session" }),
    });
    await enforcePermission("write_file", write(""), ctx);
    await enforcePermission("write_file", write("dangling/file.txt"), ctx);
    expect(sessionAllowlist).toEqual([]);
  });

  it("never lets a command grant stand in for a tool grant, or the reverse", async () => {
    const ws = makeWorkspace();
    const sessionAllowlist: string[] = [];
    const prompts: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm: async (req) => {
        prompts.push(req);
        return { allow: true, remember: "session" };
      },
    });
    await enforcePermission("write_file", write("a.txt"), ctx);
    await enforcePermission("run_command", run(`write_file ${sessionAllowlist[0]!.split("\u0000")[1]}`), ctx);
    expect(prompts).toHaveLength(2);
    await enforcePermission("run_command", run("write_file\u0000/tmp"), ctx);
    expect(sessionAllowlist.some((entry) => entry === "write_file\u0000/tmp")).toBe(false);
    await enforcePermission("git_commit", { permission: "execute", description: "c" }, ctx);
    await enforcePermission("run_command", run("git_commit"), ctx);
    expect(prompts).toHaveLength(5);
  });
});
