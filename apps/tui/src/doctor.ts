/**
 * /doctor — environment diagnostics for the TUI.
 *
 * All system access goes through an injectable DoctorProbes bag so runDoctor
 * stays pure and unit-testable; createDefaultProbes() wires the real OS.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A single diagnostic result rendered as one line by formatDoctorLines. */
export type DoctorCheck = { name: string; ok: boolean; detail: string; fixHint?: string };

/** System probes injected into runDoctor; swap with fakes in tests. */
export type DoctorProbes = {
  env: (key: string) => string | undefined;
  fileExists: (path: string) => boolean;
  nodeVersion: () => string;
  platform: () => string;
  commandExists: (bin: string) => boolean;
  /** Entries in a directory, null when it does not exist. */
  countDir: (path: string) => number | null;
};

/** Real-OS probes used by the app; tests should build their own fakes. */
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
function clipboardCandidates(platform: string): string[] {
  return platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
}

/**
 * Runs every diagnostic and returns one DoctorCheck per concern. Pure given
 * the probes: no direct fs/env/process access happens here.
 */
export function runDoctor(
  projectPath: string,
  config: { apiKey?: string; runtimeBin?: string; mcpServers?: Record<string, unknown> },
  probes: DoctorProbes,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  checks.push(
    config.apiKey
      ? { name: "api key", ok: true, detail: "configured" }
      : { name: "api key", ok: false, detail: "missing", fixHint: "restart seekforge-tui for the setup wizard, or export DEEPSEEK_API_KEY" },
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
      : { name: "git repo", ok: false, detail: "not a git repository — checkpoints and /diff are limited", fixHint: "git init" },
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
  checks.push({
    name: "mcp servers",
    ok: true,
    detail: `${mcpCount} configured`,
  });

  const sessions = probes.countDir(join(projectPath, ".seekforge", "sessions"));
  checks.push({
    name: "sessions",
    ok: true,
    detail: sessions === null ? "no sessions yet" : `${sessions} recorded`,
  });

  checks.push(
    probes.fileExists(join(projectPath, ".seekforge", "memory", "project.md"))
      ? { name: "project memory", ok: true, detail: ".seekforge/memory/project.md" }
      : { name: "project memory", ok: false, detail: "no .seekforge/memory/project.md — /memory creates one" },
  );

  const editor = probes.env("EDITOR") ?? probes.env("VISUAL");
  checks.push(
    editor
      ? { name: "editor", ok: true, detail: editor }
      : { name: "editor", ok: false, detail: "$EDITOR/$VISUAL unset — ctrl-e external edit unavailable" },
  );

  const clip = clipboardCandidates(probes.platform()).find((bin) => probes.commandExists(bin));
  checks.push(
    clip
      ? { name: "clipboard", ok: true, detail: clip }
      : { name: "clipboard", ok: false, detail: "no clipboard tool found (pbcopy/wl-copy/xclip)" },
  );

  return checks;
}

/**
 * Renders checks as "✓ name  detail" / "✗ name  detail" lines plus a final
 * "N/M checks passed" summary, padded so details line up.
 */
export function formatDoctorLines(checks: DoctorCheck[]): string[] {
  const width = Math.max(0, ...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(width)}  ${c.detail}`);
    if (!c.ok && c.fixHint) lines.push(`  ${" ".repeat(width)}  → fix: ${c.fixHint}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  lines.push(`${passed}/${checks.length} checks passed`);
  return lines;
}
