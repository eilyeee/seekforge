/**
 * Doctor framework — the diagnostic engine and the checks that are genuinely
 * identical between `seekforge doctor` (apps/cli/src/commands/doctor.ts) and
 * the TUI's /doctor (apps/tui/src/doctor.ts), which used to be parallel
 * reimplementations.
 *
 * Split of responsibilities:
 *   - here: DoctorCheck/DoctorProbes shapes, the base real-OS probe bag,
 *     clipboardCandidates, the shared check builders, configKeysCheck /
 *     configParseCheck, and the formatDoctorLines rendering engine;
 *   - apps: their runDoctor composition (each has app-only checks — the TUI's
 *     project-memory line, the CLI's desktop/GUI diagnostics and its
 *     unrecognized-provider warning), extra probes (the CLI extends the bag
 *     with which/findRepoRoot/glob/readText), and any DELIBERATELY different
 *     user-visible wording, passed in as parameters so doctor output stays
 *     byte-identical per app (it is asserted in both apps' tests).
 *
 * NODE-ONLY (spawnSync/fs in createDefaultProbes), so it lives behind the
 * "./doctor" subpath export and is NOT re-exported from index.ts (the package
 * root must stay browser-safe for the desktop bundle).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A single diagnostic result rendered as one line by formatDoctorLines.
 * `ok: false` is a failure (✗); `ok: true` with `warn: true` is a non-fatal
 * warning (~) that does not flip the summary / exit code.
 */
export type DoctorCheck = { name: string; ok: boolean; warn?: boolean; detail: string; fixHint?: string };

/**
 * System probes injected into the checks; swap with fakes in tests. This is
 * the base bag shared by both apps — the CLI extends it with its desktop
 * probes (which/findRepoRoot/glob/readText).
 */
export type DoctorProbes = {
  env: (key: string) => string | undefined;
  fileExists: (path: string) => boolean;
  nodeVersion: () => string;
  platform: () => string;
  commandExists: (bin: string) => boolean;
  /** Entry count of a directory, or null when it does not exist. */
  countDir: (path: string) => number | null;
};

/** Real-OS probes used by the apps; tests should build their own fakes. */
export function createDefaultProbes(): DoctorProbes {
  return {
    env: (key) => process.env[key],
    fileExists: (path) => existsSync(path),
    nodeVersion: () => process.version,
    platform: () => process.platform,
    commandExists: (bin) => {
      try {
        return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    },
    countDir: (path) => {
      try {
        return readdirSync(path).length;
      } catch {
        return null;
      }
    },
  };
}

/** Clipboard binaries probed per platform (first hit wins). */
export function clipboardCandidates(platform: string): string[] {
  return platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
}

// ---------------------------------------------------------------------------
// Shared check builders. The caller resolves provider/baseUrl itself (that
// needs core's preset table, which shared must not depend on) and passes any
// app-specific wording in explicitly.
// ---------------------------------------------------------------------------

/** The plain "provider (baseUrl)" line (the CLI wraps this with its own warn branch). */
export function providerCheck(provider: string, baseUrl: string): DoctorCheck {
  return { name: "provider", ok: true, detail: `${provider} (${baseUrl})` };
}

/**
 * The right key satisfies the check: ARK_API_KEY for ark, DEEPSEEK_API_KEY
 * otherwise; an explicit apiKey in config works for either. The missing-key
 * fix hint differs per app (setup-wizard vs `config set`) so it is built by
 * the caller from the env-var name.
 */
export function apiKeyCheck(
  provider: string,
  apiKey: string | undefined,
  env: DoctorProbes["env"],
  missingFixHint: (keyEnv: string) => string,
): DoctorCheck {
  const keyEnv = provider === "ark" ? "ARK_API_KEY" : "DEEPSEEK_API_KEY";
  const hasKey = Boolean(apiKey ?? env(keyEnv));
  return hasKey
    ? { name: "api key", ok: true, detail: "configured" }
    : { name: "api key", ok: false, detail: "missing", fixHint: missingFixHint(keyEnv) };
}

export function nodeCheck(probes: DoctorProbes): DoctorCheck {
  const version = probes.nodeVersion();
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  return Number.isFinite(major) && major >= 20
    ? { name: "node", ok: true, detail: `${version} (>= 20)` }
    : {
        name: "node",
        ok: false,
        detail: `${version} — SeekForge requires node >= 20`,
        fixHint: "nvm install 22 && nvm use 22",
      };
}

export function platformCheck(probes: DoctorProbes): DoctorCheck {
  return { name: "platform", ok: true, detail: probes.platform() };
}

/** `diffLabel` is the app's diff affordance: "`diff`" (CLI) / "/diff" (TUI). */
export function gitRepoCheck(projectPath: string, probes: DoctorProbes, diffLabel: string): DoctorCheck {
  return probes.fileExists(join(projectPath, ".git"))
    ? { name: "git repo", ok: true, detail: ".git present" }
    : {
        name: "git repo",
        ok: false,
        detail: `not a git repository — checkpoints and ${diffLabel} are limited`,
        fixHint: "git init",
      };
}

export function projectConfigCheck(projectPath: string, probes: DoctorProbes): DoctorCheck {
  return probes.fileExists(join(projectPath, ".seekforge", "config.json"))
    ? { name: "project config", ok: true, detail: ".seekforge/config.json" }
    : { name: "project config", ok: true, detail: "using global defaults" };
}

export function rustRuntimeCheck(runtimeBin: string | undefined, probes: DoctorProbes): DoctorCheck {
  if (!runtimeBin) return { name: "rust runtime", ok: true, detail: "not configured (TS fallback)" };
  return probes.fileExists(runtimeBin)
    ? { name: "rust runtime", ok: true, detail: runtimeBin }
    : {
        name: "rust runtime",
        ok: false,
        detail: `${runtimeBin} not found`,
        fixHint: "fix runtimeBin in config.json or remove it (TS fallback works)",
      };
}

export function mcpServersCheck(mcpServers: Record<string, unknown> | undefined): DoctorCheck {
  const mcpCount = Object.keys(mcpServers ?? {}).length;
  return { name: "mcp servers", ok: true, detail: `${mcpCount} configured` };
}

export function sessionsCheck(projectPath: string, probes: DoctorProbes): DoctorCheck {
  const sessions = probes.countDir(join(projectPath, ".seekforge", "sessions"));
  return { name: "sessions", ok: true, detail: sessions === null ? "no sessions yet" : `${sessions} recorded` };
}

/** `missingDetail` differs per app ("ctrl-e external edit" vs "external edit"). */
export function editorCheck(probes: DoctorProbes, missingDetail: string): DoctorCheck {
  const editor = probes.env("EDITOR") ?? probes.env("VISUAL");
  return editor ? { name: "editor", ok: true, detail: editor } : { name: "editor", ok: false, detail: missingDetail };
}

export function clipboardCheck(probes: DoctorProbes): DoctorCheck {
  const clip = clipboardCandidates(probes.platform()).find((bin) => probes.commandExists(bin));
  return clip
    ? { name: "clipboard", ok: true, detail: clip }
    : { name: "clipboard", ok: false, detail: "no clipboard tool found (pbcopy/wl-copy/xclip)" };
}

/**
 * Warns about unrecognized config keys (typos silently ignored otherwise). A
 * warning, not a failure — an unknown key is harmless, just probably a
 * mistake. The default fix hint is the TUI wording; the CLI passes its own
 * (pointing at docs/configuration.md).
 */
export function configKeysCheck(
  unknownKeys: string[],
  fixHint = "check for typos — see the config docs for valid keys",
): DoctorCheck {
  if (unknownKeys.length === 0) return { name: "config keys", ok: true, detail: "all recognized" };
  return {
    name: "config keys",
    ok: true,
    warn: true,
    detail: `unrecognized: ${unknownKeys.join(", ")}`,
    fixHint,
  };
}

/**
 * Fails when an existing config.json layer is syntactically broken or is not a
 * JSON object. `readJson` collapses either case to `{}`, so without this check a
 * malformed config silently drops every setting AND doctor reports clean.
 */
export function configParseCheck(errors: string[]): DoctorCheck {
  if (errors.length === 0) return { name: "config parse", ok: true, detail: "all config files are valid" };
  return {
    name: "config parse",
    ok: false,
    detail: `invalid: ${errors.join(", ")}`,
    fixHint: "use a valid JSON object",
  };
}

/** Rendering hooks so the CLI can color marks and localize its hint/summary lines. */
export type DoctorFormatOptions = {
  /** Decorates the ✗/~/✓ mark (the CLI wraps it in red/yellow/green). */
  mark?: (mark: "✗" | "~" | "✓") => string;
  /** Renders a fix-hint line body; default `→ fix: ${hint}` (TUI wording). */
  fixHint?: (hint: string) => string;
  /** Renders the summary line; default `${passed}/${total} checks passed`. */
  summary?: (passed: number, total: number) => string;
};

/**
 * Renders checks as "✓ name  detail" / "~ name  detail" (warning) / "✗ name
 * detail" (failure) lines plus a final summary, padded so details line up.
 * Fix hints are shown for failures and warnings alike. "passed" counts ✓ AND ~
 * (warnings are non-fatal); only ✗ are failures.
 */
export function formatDoctorLines(checks: DoctorCheck[], opts: DoctorFormatOptions = {}): string[] {
  const markOf = opts.mark ?? ((m) => m);
  const hintOf = opts.fixHint ?? ((hint) => `→ fix: ${hint}`);
  const summaryOf = opts.summary ?? ((passed, total) => `${passed}/${total} checks passed`);
  const width = Math.max(0, ...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    const mark = markOf(!c.ok ? "✗" : c.warn ? "~" : "✓");
    lines.push(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
    if ((!c.ok || c.warn) && c.fixHint) lines.push(`  ${" ".repeat(width)}  ${hintOf(c.fixHint)}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  lines.push(summaryOf(passed, checks.length));
  return lines;
}
