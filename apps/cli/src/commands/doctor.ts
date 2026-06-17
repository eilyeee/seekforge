// `seekforge doctor` — environment diagnostics for the CLI.
//
// Thin reimplementation of the TUI's /doctor logic (apps/tui/src/doctor.ts);
// we do NOT import across apps. Checks are pure given the probes bag so the
// list logic could be unit-tested; the command itself wires the real OS.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dim, green, red, yellow } from "../colors.js";
import { t } from "../i18n.js";
import { loadConfig } from "../config.js";

/**
 * A diagnostic line. `ok: false` is an error (✗); `ok: true` with `warn: true`
 * is a non-fatal warning (~, does not flip the exit code). The "missing"
 * category is expressed as `ok: false` (an absent thing that should be there)
 * or `warn` (an optional/dev-only thing that is fine to be absent).
 */
export type DoctorCheck = { name: string; ok: boolean; warn?: boolean; detail: string; fixHint?: string };

export type DoctorProbes = {
  env: (key: string) => string | undefined;
  fileExists: (path: string) => boolean;
  nodeVersion: () => string;
  platform: () => string;
  commandExists: (bin: string) => boolean;
  /** Entry count of a directory, or null when it does not exist. */
  countDir: (path: string) => number | null;
  /** Absolute path of `bin` resolved on PATH, or null. Never throws. */
  which: (bin: string) => string | null;
  /**
   * Repo root (a dir containing pnpm-workspace.yaml) found by walking up from
   * `start`, or null when not inside the monorepo (e.g. installed package).
   */
  findRepoRoot: (start: string) => string | null;
  /** Basenames matching `glob` (a single `*` wildcard) in `dir`, or [] / null. */
  glob: (dir: string, pattern: string) => string[] | null;
  /** File contents as UTF-8, or null when unreadable. Never throws. */
  readText: (path: string) => string | null;
};

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
    which: (bin) => {
      try {
        const r = spawnSync("which", [bin], { encoding: "utf8" });
        if (r.status !== 0) return null;
        const out = (r.stdout ?? "").trim().split("\n")[0]?.trim();
        return out ? out : null;
      } catch {
        return null;
      }
    },
    findRepoRoot: (start) => {
      try {
        let dir = start;
        for (let i = 0; i < 64; i++) {
          if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
          const parent = dirname(dir);
          if (parent === dir) return null;
          dir = parent;
        }
        return null;
      } catch {
        return null;
      }
    },
    glob: (dir, pattern) => {
      try {
        const star = pattern.indexOf("*");
        const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
        const suffix = star >= 0 ? pattern.slice(star + 1) : "";
        return readdirSync(dir).filter(
          (name) => (star < 0 ? name === pattern : name.startsWith(prefix) && name.endsWith(suffix)),
        );
      } catch {
        return null;
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function clipboardCandidates(platform: string): string[] {
  return platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
}

/**
 * Global-bin locations the macOS desktop shell appends to PATH before searching
 * for `seekforge`, because GUI apps inherit a minimal launchd PATH that omits
 * where `npm i -g` installs. Kept in sync with
 * apps/desktop/src-tauri/README.md ("How the serve command is resolved").
 */
const GUI_PATH_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "~/.npm-global/bin",
  "~/.local/bin",
  "~/.volta/bin",
  "~/.yarn/bin",
  "~/.bun/bin",
  "~/.nvm/versions/node/*/bin",
];

/** Base64 placeholder pubkey that marks the Tauri updater as disabled. */
const DISABLED_UPDATER_PUBKEY = "dW50cnVzdGVkIGNvbW1lbnQ6IHVwZGF0ZXIgZGlzYWJsZWQ=";

/** Runs every diagnostic. Pure given the probes (no direct fs/env access). */
export function runDoctor(
  projectPath: string,
  config: { apiKey?: string; runtimeBin?: string; mcpServers?: Record<string, unknown> },
  probes: DoctorProbes,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  checks.push(
    config.apiKey
      ? { name: "api key", ok: true, detail: "configured" }
      : {
          name: "api key",
          ok: false,
          detail: "missing",
          fixHint: "export DEEPSEEK_API_KEY, or `seekforge config set apiKey <key>`",
        },
  );

  const version = probes.nodeVersion();
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  checks.push(
    Number.isFinite(major) && major >= 20
      ? { name: "node", ok: true, detail: `${version} (>= 20)` }
      : { name: "node", ok: false, detail: `${version} — SeekForge requires node >= 20`, fixHint: "nvm install 22 && nvm use 22" },
  );

  checks.push({ name: "platform", ok: true, detail: probes.platform() });

  checks.push(
    probes.fileExists(join(projectPath, ".git"))
      ? { name: "git repo", ok: true, detail: ".git present" }
      : { name: "git repo", ok: false, detail: "not a git repository — checkpoints and `diff` are limited", fixHint: "git init" },
  );

  checks.push(
    probes.fileExists(join(projectPath, ".seekforge", "config.json"))
      ? { name: "project config", ok: true, detail: ".seekforge/config.json" }
      : { name: "project config", ok: true, detail: "using global defaults" },
  );

  if (config.runtimeBin) {
    checks.push(
      probes.fileExists(config.runtimeBin)
        ? { name: "rust runtime", ok: true, detail: config.runtimeBin }
        : { name: "rust runtime", ok: false, detail: `${config.runtimeBin} not found`, fixHint: "fix runtimeBin in config.json or remove it (TS fallback works)" },
    );
  } else {
    checks.push({ name: "rust runtime", ok: true, detail: "not configured (TS fallback)" });
  }

  const mcpCount = Object.keys(config.mcpServers ?? {}).length;
  checks.push({ name: "mcp servers", ok: true, detail: `${mcpCount} configured` });

  const sessions = probes.countDir(join(projectPath, ".seekforge", "sessions"));
  checks.push({ name: "sessions", ok: true, detail: sessions === null ? "no sessions yet" : `${sessions} recorded` });

  const editor = probes.env("EDITOR") ?? probes.env("VISUAL");
  checks.push(
    editor
      ? { name: "editor", ok: true, detail: editor }
      : { name: "editor", ok: false, detail: "$EDITOR/$VISUAL unset — external edit unavailable" },
  );

  const clip = clipboardCandidates(probes.platform()).find((bin) => probes.commandExists(bin));
  checks.push(
    clip
      ? { name: "clipboard", ok: true, detail: clip }
      : { name: "clipboard", ok: false, detail: "no clipboard tool found (pbcopy/wl-copy/xclip)" },
  );

  // Best-effort desktop/GUI diagnostics. Each is wrapped so a probe surprise
  // can never abort the whole report; a thrown probe degrades to a warn line.
  for (const make of [seekforgeOnPathCheck, sidecarCheck, webDistCheck, updaterCheck]) {
    try {
      const c = make(projectPath, probes);
      if (c) checks.push(c);
    } catch {
      checks.push({ name: "desktop", ok: true, warn: true, detail: "diagnostic skipped (probe error)" });
    }
  }

  return checks;
}

/**
 * Whether `seekforge` resolves on PATH. This is the "GUI app can't find
 * seekforge" diagnostic: the macOS desktop shell augments PATH with the
 * GUI_PATH_DIRS before searching, so we note them when the binary is missing.
 */
function seekforgeOnPathCheck(_projectPath: string, probes: DoctorProbes): DoctorCheck {
  const resolved = probes.which("seekforge");
  if (resolved) return { name: "seekforge on PATH", ok: true, detail: resolved };
  return {
    name: "seekforge on PATH",
    ok: true,
    warn: true,
    detail: "not on PATH — the desktop app augments PATH with these GUI-bin dirs before searching",
    fixHint: `ensure one of: ${GUI_PATH_DIRS.join(", ")}`,
  };
}

/**
 * Desktop sidecar binary (binaries/seekforge-server-<target-triple>). Only
 * meaningful inside the monorepo; outside it (installed package) we skip.
 */
function sidecarCheck(projectPath: string, probes: DoctorProbes): DoctorCheck | null {
  const root = probes.findRepoRoot(projectPath);
  if (!root) return null; // not in the monorepo — nothing to diagnose
  const dir = join(root, "apps", "desktop", "src-tauri", "binaries");
  const matches = probes.glob(dir, "seekforge-server-*");
  if (matches && matches.length > 0) {
    return { name: "desktop sidecar", ok: true, detail: matches.join(", ") };
  }
  return {
    name: "desktop sidecar",
    ok: true,
    warn: true,
    detail: "not built (~70 MB, rebuilt per release)",
    fixHint: "pnpm --filter seekforge build:sidecar",
  };
}

/** Prebuilt web workbench the desktop shell serves (apps/desktop/dist/index.html). */
function webDistCheck(projectPath: string, probes: DoctorProbes): DoctorCheck | null {
  const root = probes.findRepoRoot(projectPath);
  if (!root) return null;
  const indexHtml = join(root, "apps", "desktop", "dist", "index.html");
  if (probes.fileExists(indexHtml)) return { name: "web dist", ok: true, detail: indexHtml };
  return {
    name: "web dist",
    ok: true,
    warn: true,
    detail: "apps/desktop/dist/index.html missing",
    fixHint: "pnpm --filter @seekforge/desktop build",
  };
}

/**
 * Tauri updater status from tauri.conf.json: reports createUpdaterArtifacts and
 * whether the updater pubkey is the disabled placeholder.
 */
function updaterCheck(projectPath: string, probes: DoctorProbes): DoctorCheck | null {
  const root = probes.findRepoRoot(projectPath);
  if (!root) return null;
  const confPath = join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const raw = probes.readText(confPath);
  if (raw === null) return null; // no desktop conf — skip gracefully
  let conf: {
    bundle?: { createUpdaterArtifacts?: boolean };
    plugins?: { updater?: { pubkey?: string } };
  };
  try {
    conf = JSON.parse(raw);
  } catch {
    return { name: "updater", ok: true, warn: true, detail: "tauri.conf.json unparseable" };
  }
  const artifacts = conf.bundle?.createUpdaterArtifacts === true;
  const pubkey = conf.plugins?.updater?.pubkey ?? "";
  const disabled = pubkey === DISABLED_UPDATER_PUBKEY;
  if (disabled || !artifacts) {
    return {
      name: "updater",
      ok: true,
      warn: true,
      detail: `disabled (createUpdaterArtifacts: ${artifacts}${disabled ? ", placeholder pubkey" : ""})`,
    };
  }
  return { name: "updater", ok: true, detail: "enabled (createUpdaterArtifacts: true)" };
}

/** Renders checks as colored "✓/~/✗ name detail" lines + a pass summary. */
export function formatDoctorLines(checks: DoctorCheck[]): string[] {
  const width = Math.max(0, ...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    const mark = !c.ok ? red("✗") : c.warn ? yellow("~") : green("✓");
    lines.push(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
    // Fix hints are shown for failures and warnings alike.
    if ((!c.ok || c.warn) && c.fixHint)
      lines.push(`  ${" ".repeat(width)}  ${dim(t("cmd.doctor.fixHint", { hint: c.fixHint }))}`);
  }
  // "passed" counts ✓ and ~ (warnings are non-fatal); only ✗ are failures.
  const passed = checks.filter((c) => c.ok).length;
  lines.push(t("cmd.doctor.checksHeader", { passed, total: checks.length }));
  return lines;
}

/** `seekforge doctor` entry point. Exit code 1 if any check failed (warnings do not fail). */
export function doctorCommand(): void {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  const checks = runDoctor(projectPath, config, createDefaultProbes());
  for (const line of formatDoctorLines(checks)) console.log(line);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}
