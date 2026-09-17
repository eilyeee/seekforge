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
import {
  coreConfigCheck,
  pdftotextCheck,
  proxyCheck,
  runDoctor,
  telemetryCheck,
  type DoctorProbes,
} from "../commands/doctor.js";

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

describe("doctor proxy, telemetry and pdftotext checks", () => {
  function probes(env: Record<string, string>, over: Partial<DoctorProbes> = {}): DoctorProbes {
    return {
      env: (key) => env[key],
      environment: () => env,
      fileExists: () => true,
      nodeVersion: () => "v22.22.1",
      platform: () => "darwin",
      commandExists: () => false,
      countDir: () => 0,
      which: () => null,
      findRepoRoot: () => null,
      glob: () => null,
      readText: () => null,
      execArgv: () => [],
      allowedNodeFlags: () => new Set(["--use-env-proxy"]),
      ...over,
    };
  }

  it("says nothing about a proxy nobody configured", () => {
    expect(proxyCheck(probes({}))).toBeUndefined();
    expect(runDoctor("/proj", { apiKey: "k" }, probes({})).map((c) => c.name)).not.toContain("proxy");
  });

  it("reports whether this process was started to use the proxy (the launcher's --use-env-proxy)", () => {
    const launched = proxyCheck(
      probes(
        { HTTPS_PROXY: "http://u:p@proxy:1", NO_PROXY: "localhost" },
        {
          execArgv: () => ["--use-env-proxy"],
        },
      ),
    );
    expect(launched).toMatchObject({ name: "proxy", ok: true });
    expect(launched?.warn).toBeUndefined();
    expect(launched?.detail).toContain("requests use HTTPS_PROXY");
    expect(launched?.detail).toContain("NO_PROXY=localhost");
    // Only the variable's name is printed, never its value (which may carry credentials).
    expect(launched?.detail).not.toContain("u:p");

    const direct = proxyCheck(probes({ HTTPS_PROXY: "http://p:1" }));
    expect(direct).toMatchObject({ ok: true, warn: true });
    expect(direct?.fixHint).toContain("launcher");
    expect(direct?.fixHint).not.toContain("export NODE_USE_ENV_PROXY=1 (or NODE_OPTIONS");

    const oldNode = proxyCheck(
      probes({ http_proxy: "http://p:1" }, { allowedNodeFlags: () => new Set(), nodeVersion: () => "v20.1.0" }),
    );
    expect(oldNode).toMatchObject({ ok: true, warn: true });
    expect(oldNode?.detail).toContain("v20.1.0");
    expect(proxyCheck(probes({ ALL_PROXY: "socks5://x" }))?.detail).toContain("does not read it");
  });

  it("describes telemetry export and its configuration problems", () => {
    expect(telemetryCheck(probes({}))).toEqual({
      name: "telemetry",
      ok: true,
      detail: "off (set SEEKFORGE_ENABLE_TELEMETRY=1 to export)",
    });
    const on = telemetryCheck(
      probes({
        SEEKFORGE_ENABLE_TELEMETRY: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example:4318",
      }),
    );
    expect(on.ok).toBe(true);
    expect(on.detail).toContain("collector.example");
    expect(on.detail).not.toContain("secret");
    const broken = telemetryCheck(probes({ SEEKFORGE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }));
    expect(broken).toMatchObject({ ok: true, warn: true, fixHint: expect.stringContaining("telemetry.md") });
    expect(broken.detail).toContain("grpc");
  });

  it("surfaces a malformed apiKeyHelper in the user config", () => {
    const read = (text: string) => probes({}, { readText: () => text });
    expect(coreConfigCheck(read('{"apiKeyHelper": ""}'), "/home/u/.seekforge/config.json")).toMatchObject({
      ok: true,
      warn: true,
      detail: expect.stringContaining("apiKeyHelper must be a non-empty string"),
    });
    expect(coreConfigCheck(read('{"apiKeyHelper": "pass show key"}'), "/c.json")).toBeUndefined();
    expect(coreConfigCheck(read("{not json"), "/c.json")).toBeUndefined();
    expect(coreConfigCheck(probes({}), "/c.json")).toBeUndefined();
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

  it("includes them in the report without failing it", () => {
    const checks = runDoctor("/proj", { apiKey: "k" }, probes({ EDITOR: "vi", HTTPS_PROXY: "http://p:1" }));
    const names = ["proxy", "pdftotext", "telemetry"];
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(names));
    expect(checks.filter((c) => names.includes(c.name)).every((c) => c.ok)).toBe(true);
  });
});
