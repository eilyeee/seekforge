import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTrace, renameSession, writeSessionMeta } from "@seekforge/core";
import {
  formatSessionLine,
  sessionsCommand,
  sessionsRenameCommand,
  sessionsShowCommand,
} from "../commands/sessions.js";
import { updateCommand, type UpdateDeps } from "../commands/update.js";
import { detectInstallMethod, OFFICIAL_NPM_REGISTRY, upgradeCommand } from "../install-method.js";
import { pdftotextCheck, proxyCheck, redactProxyUrl, runDoctor, type DoctorProbes } from "../commands/doctor.js";

let cwd: string;
let out: string[];
let err: string[];
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-sessions-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(cwd, { recursive: true, force: true });
});

function seed(id: string, task: string, createdAt: string): void {
  writeSessionMeta(cwd, {
    id,
    task,
    mode: "edit",
    status: "completed",
    createdAt,
    updatedAt: createdAt,
    usage: { promptTokens: 1000, completionTokens: 10, cacheHitTokens: 0, costUsd: 0.25 },
    plan: [{ step: "write the test", status: "done" }],
  });
  const trace = createSessionTrace(cwd, id);
  trace.message({ role: "system", content: "s" });
  trace.message({ role: "user", content: task });
}

describe("sessions", () => {
  it("lists names before the task's first line", () => {
    seed("s1", "fix the bug\n\n<user-shell-commands>\n…", "2026-01-01T00:00:00.000Z");
    renameSession(cwd, "s1", "Bug hunt");
    seed("s2", "plain task", "2026-01-02T00:00:00.000Z");
    sessionsCommand();
    expect(out).toEqual(["s2  [completed] $0.2500  plain task", "s1  [completed] $0.2500  «Bug hunt» fix the bug"]);
    expect(
      formatSessionLine(
        cwd,
        { id: "s2", task: "x", mode: "edit", status: "idle", createdAt: "", updatedAt: "" },
        { cost: false },
      ),
    ).toBe("s2  [idle]  x");
  });

  it("renames, clears and refuses unknown sessions", () => {
    seed("s1", "task", "2026-01-01T00:00:00.000Z");
    sessionsRenameCommand("s1", ["Release", "  prep "]);
    expect(out.at(-1)).toBe('session s1 is now "Release prep"');
    sessionsRenameCommand("s1", [""]);
    expect(out.at(-1)).toBe("session s1 no longer has a name");
    sessionsRenameCommand("ghost", ["x"]);
    expect(err.join("")).toContain('session "ghost" not found');
    expect(process.exitCode).toBe(1);
  });

  it("shows one session as text and as JSON", () => {
    seed("s1", "the task\nsecond line", "2026-01-01T00:00:00.000Z");
    renameSession(cwd, "s1", "Named");
    sessionsShowCommand("s1");
    const text = out.join("\n");
    expect(text).toContain("session:  s1");
    expect(text).toContain("name:     Named");
    expect(text).toContain("status:   completed (edit)");
    expect(text).toContain("messages: 2");
    expect(text).toContain("☑ write the test");
    expect(text).toContain("the task\nsecond line");
    out = [];
    sessionsShowCommand("s1", { json: true });
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      id: "s1",
      name: "Named",
      messages: 2,
      usage: { costUsd: 0.25 },
      task: "the task\nsecond line",
    });
    sessionsShowCommand("ghost");
    expect(process.exitCode).toBe(1);
  });
});

describe("detectInstallMethod / upgradeCommand", () => {
  it("classifies install layouts", () => {
    const npmRoot = "/usr/local/lib/node_modules";
    expect(detectInstallMethod({ entryPath: `${npmRoot}/seekforge/bin/seekforge.js`, npmGlobalRoot: npmRoot })).toBe(
      "npm",
    );
    expect(detectInstallMethod({ entryPath: `${npmRoot}/seekforge/bin/seekforge.js`, npmGlobalRoot: "/other" })).toBe(
      "unknown",
    );
    expect(
      detectInstallMethod({
        entryPath: "/Users/me/Library/pnpm/global/5/.pnpm/seekforge@1.0.0/node_modules/seekforge/bin/seekforge.js",
      }),
    ).toBe("pnpm");
    expect(
      detectInstallMethod({
        entryPath: "/Users/me/.volta/tools/image/packages/seekforge/lib/node_modules/seekforge/bin/x.js",
      }),
    ).toBe("volta");
    expect(
      detectInstallMethod({
        entryPath: "/Users/me/.npm/_npx/abc/node_modules/seekforge/bin/x.js",
        npmGlobalRoot: "/Users/me/.npm/_npx/abc/node_modules",
      }),
    ).toBe("unknown");
    expect(
      detectInstallMethod({ entryPath: "/src/seekforge/apps/cli/bin/seekforge.js", repoRoot: "/src/seekforge" }),
    ).toBe("dev");
    expect(detectInstallMethod({ entryPath: "/opt/seekforge" })).toBe("unknown");
  });

  it("builds upgrade commands against the official registry", () => {
    expect(upgradeCommand("npm", "darwin")).toMatchObject({
      command: "npm",
      args: ["install", "-g", "seekforge@latest", `--registry=${OFFICIAL_NPM_REGISTRY}`],
    });
    expect(upgradeCommand("pnpm", "win32")?.command).toBe("pnpm.cmd");
    expect(upgradeCommand("pnpm", "linux")?.args).toContain(`--registry=${OFFICIAL_NPM_REGISTRY}`);
    expect(upgradeCommand("volta", "linux")).toMatchObject({
      args: ["install", "seekforge@latest"],
      env: { npm_config_registry: OFFICIAL_NPM_REGISTRY },
    });
    expect(upgradeCommand("unknown")).toBeNull();
    expect(upgradeCommand("dev")).toBeNull();
  });
});

describe("updateCommand", () => {
  function deps(over: Partial<UpdateDeps> = {}): UpdateDeps & { ran: string[] } {
    const ran: string[] = [];
    return {
      ran,
      currentVersion: () => "1.0.0",
      latestVersion: async () => "1.1.0",
      installMethod: () => ({ method: "npm", entryPath: "/g/seekforge/bin/seekforge.js" }),
      confirm: async () => true,
      run: async (cmd) => {
        ran.push(cmd.display);
        return 0;
      },
      interactive: true,
      ...over,
    };
  }

  it("says so when up to date", async () => {
    const d = deps({ latestVersion: async () => null });
    await updateCommand({}, d);
    expect(out).toEqual(["seekforge 1.0.0 is up to date."]);
    expect(d.ran).toEqual([]);
  });

  it("runs the detected upgrade after confirmation, printing the command first", async () => {
    const d = deps();
    await updateCommand({}, d);
    const display = `npm install -g seekforge@latest --registry=${OFFICIAL_NPM_REGISTRY}`;
    expect(out).toContain(`  ${display}`);
    expect(d.ran).toEqual([display]);
    expect(out.at(-1)).toContain("seekforge 1.1.0 installed.");
  });

  it("does not run without a yes, and never without a terminal unless -y", async () => {
    const declined = deps({ confirm: async () => false });
    await updateCommand({}, declined);
    expect(declined.ran).toEqual([]);
    const headless = deps({ interactive: false, confirm: async () => true });
    await updateCommand({}, headless);
    expect(headless.ran).toEqual([]);
    const forced = deps({ interactive: false, confirm: async () => false });
    await updateCommand({ yes: true }, forced);
    expect(forced.ran).toHaveLength(1);
  });

  it("reports a failed upgrade", async () => {
    await updateCommand({ yes: true }, deps({ run: async () => 2 }));
    expect(err.join("")).toContain("exited with code 2");
    expect(process.exitCode).toBe(1);
  });

  it("only prints instructions for an unknown or source install", async () => {
    const unknown = deps({ installMethod: () => ({ method: "unknown", entryPath: "/weird/place" }) });
    await updateCommand({ yes: true }, unknown);
    expect(unknown.ran).toEqual([]);
    expect(out.join("\n")).toContain(`npm install -g seekforge@latest --registry=${OFFICIAL_NPM_REGISTRY}`);
    const dev = deps({ installMethod: () => ({ method: "dev", entryPath: "/src/apps/cli/bin/seekforge.js" }) });
    await updateCommand({ yes: true }, dev);
    expect(dev.ran).toEqual([]);
    expect(out.at(-1)).toContain("source checkout");
  });
});

describe("doctor proxy and pdftotext checks", () => {
  function probes(env: Record<string, string>, over: Partial<DoctorProbes> = {}): DoctorProbes {
    return {
      env: (key) => env[key],
      fileExists: () => true,
      nodeVersion: () => "v22.22.1",
      platform: () => "darwin",
      commandExists: () => false,
      countDir: () => 0,
      which: () => null,
      findRepoRoot: () => null,
      glob: () => null,
      readText: () => null,
      nodeSupportsEnvProxy: () => true,
      execArgv: () => [],
      ...over,
    };
  }

  it("redacts credentials in proxy URLs", () => {
    expect(redactProxyUrl("http://user:pw@proxy:8080")).toBe("http://***@proxy:8080");
    expect(redactProxyUrl("http://proxy:8080/")).toBe("http://proxy:8080");
    expect(redactProxyUrl("user:pw@proxy")).toBe("(set, not a URL)");
  });

  it("reports proxy variables against what this node does with them", () => {
    expect(proxyCheck(probes({}))).toEqual({ name: "proxy", ok: true, detail: "no HTTP(S)_PROXY set" });
    expect(proxyCheck(probes({ ALL_PROXY: "socks5://x" })).detail).toContain("node does not read it");
    const idle = proxyCheck(probes({ HTTPS_PROXY: "http://u:p@proxy:1", NO_PROXY: "localhost" }));
    expect(idle).toMatchObject({ ok: true, fixHint: expect.stringContaining("NODE_USE_ENV_PROXY=1") });
    expect(idle.warn).toBeUndefined();
    expect(idle.detail).toContain("HTTPS_PROXY=http://***@proxy:1; NO_PROXY=localhost");
    expect(idle.detail).not.toContain("u:p");
    expect(proxyCheck(probes({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "1" })).detail).toContain("honored");
    expect(
      proxyCheck(probes({ HTTPS_PROXY: "http://p:1", NODE_OPTIONS: "--max-old-space-size=1 --use-env-proxy" })).detail,
    ).toContain("honored");
    expect(proxyCheck(probes({ HTTPS_PROXY: "http://p:1" }, { execArgv: () => ["--use-env-proxy"] })).detail).toContain(
      "honored",
    );
    const old = proxyCheck(
      probes({ http_proxy: "http://p:1" }, { nodeSupportsEnvProxy: () => false, nodeVersion: () => "v20.1.0" }),
    );
    expect(old).toMatchObject({ ok: true, warn: true });
    expect(old.detail).toContain("v20.1.0");
  });

  it("reports pdftotext informationally", () => {
    expect(pdftotextCheck(probes({}, { which: (bin) => (bin === "pdftotext" ? "/opt/bin/pdftotext" : null) }))).toEqual(
      {
        name: "pdftotext",
        ok: true,
        detail: "/opt/bin/pdftotext",
      },
    );
    expect(pdftotextCheck(probes({}))).toMatchObject({ ok: true, fixHint: expect.stringContaining("poppler") });
  });

  it("includes both in the report without failing it", () => {
    const checks = runDoctor("/proj", { apiKey: "k" }, probes({ EDITOR: "vi", HTTPS_PROXY: "http://p:1" }));
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["proxy", "pdftotext"]));
    expect(checks.filter((c) => c.name === "proxy" || c.name === "pdftotext").every((c) => c.ok)).toBe(true);
  });
});
