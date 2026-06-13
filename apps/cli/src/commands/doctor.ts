// `seekforge doctor` — environment diagnostics for the CLI.
//
// Thin reimplementation of the TUI's /doctor logic (apps/tui/src/doctor.ts);
// we do NOT import across apps. Checks are pure given the probes bag so the
// list logic could be unit-tested; the command itself wires the real OS.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dim, green, red } from "../colors.js";
import { t } from "../i18n.js";
import { loadConfig } from "../config.js";

export type DoctorCheck = { name: string; ok: boolean; detail: string; fixHint?: string };

export type DoctorProbes = {
  env: (key: string) => string | undefined;
  fileExists: (path: string) => boolean;
  nodeVersion: () => string;
  platform: () => string;
  commandExists: (bin: string) => boolean;
  /** Entry count of a directory, or null when it does not exist. */
  countDir: (path: string) => number | null;
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
  };
}

function clipboardCandidates(platform: string): string[] {
  return platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
}

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

  return checks;
}

/** Renders checks as colored "✓/✗ name detail" lines + a pass summary. */
export function formatDoctorLines(checks: DoctorCheck[]): string[] {
  const width = Math.max(0, ...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    const mark = c.ok ? green("✓") : red("✗");
    lines.push(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
    if (!c.ok && c.fixHint) lines.push(`  ${" ".repeat(width)}  ${dim(t("cmd.doctor.fixHint", { hint: c.fixHint }))}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  lines.push(t("cmd.doctor.checksHeader", { passed, total: checks.length }));
  return lines;
}

/** `seekforge doctor` entry point. Exit code 1 if any check failed. */
export function doctorCommand(): void {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  const checks = runDoctor(projectPath, config, createDefaultProbes());
  for (const line of formatDoctorLines(checks)) console.log(line);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}
