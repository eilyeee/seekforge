import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookEntry } from "@seekforge/core";
import { formatDurationCoarse, kfmt } from "./format.js";
import type { TuiConfig } from "./config.js";

/**
 * Pure formatters for the batch-D slash commands
 * (/status, /config, /permissions, /hooks, /release-notes, /bug).
 * Every formatter returns ready-to-print lines the app dispatches as dim
 * notices (buildBugReport returns one markdown string for the clipboard),
 * so they stay unit-testable without rendering Ink.
 */

const ISSUES_URL = "https://github.com/eilyeee/seekforge/issues";
const CHANGELOG_URL = "github.com/eilyeee/seekforge/blob/main/CHANGELOG.md";

/** Caps a single-line string to `max` chars with an ellipsis. */
function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Renders [label, value] pairs as a compact aligned two-column block. */
function alignPairs(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.max(0, ...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

export type StatusInput = {
  version?: string;
  model: string;
  projectPath: string;
  sessionId?: string;
  approval: string;
  vim: boolean;
  thinking?: boolean;
  reasoningEffort?: string;
  sandbox?: string;
  keySource: "env" | "config" | "none";
  costUsd: number;
  totalTokens: number;
  contextPercent?: number;
  mcpServers: number;
  extraDirs: number;
  bgRunning: number;
  detachedRuns: number;
  /** Wall-clock ms since the TUI started; rendered as an "uptime" row. */
  uptimeMs?: number;
};

/** Human label for where the API key came from. */
function keySourceLabel(source: StatusInput["keySource"]): string {
  switch (source) {
    case "env":
      return "DEEPSEEK_API_KEY (env)";
    case "config":
      return "config file";
    default:
      return "not set";
  }
}

/**
 * Compact aligned "label  value" block for /status. Zero/absent rows
 * (context %, uptime, MCP servers, extra dirs, background tasks, version)
 * are omitted; a missing session shows as "(new)".
 */
export function formatStatusLines(s: StatusInput): string[] {
  const pairs: Array<readonly [string, string]> = [];

  if (s.version) pairs.push(["version", s.version]);

  let model = s.model;
  if (s.thinking) {
    model += s.reasoningEffort ? ` (thinking, effort ${s.reasoningEffort})` : " (thinking)";
  }
  pairs.push(["model", model]);
  pairs.push(["workspace", s.projectPath]);
  pairs.push(["session", s.sessionId ?? "(new)"]);
  pairs.push(["approval", s.approval]);
  pairs.push(["vim", s.vim ? "on" : "off"]);
  pairs.push(["sandbox", s.sandbox ?? "off"]);
  pairs.push(["api key", keySourceLabel(s.keySource)]);
  pairs.push(["cost", `$${s.costUsd.toFixed(4)} · ${kfmt(s.totalTokens)} tokens`]);
  if (s.uptimeMs !== undefined) pairs.push(["uptime", formatDurationCoarse(s.uptimeMs)]);
  if (s.contextPercent !== undefined) pairs.push(["context", `${Math.round(s.contextPercent)}% used`]);
  if (s.mcpServers > 0) {
    pairs.push(["mcp", `${s.mcpServers} ${s.mcpServers === 1 ? "server" : "servers"}`]);
  }
  if (s.extraDirs > 0) {
    pairs.push(["extra dirs", `${s.extraDirs} ${s.extraDirs === 1 ? "dir" : "dirs"}`]);
  }
  if (s.bgRunning > 0 || s.detachedRuns > 0) {
    pairs.push(["background", `${s.bgRunning} running, ${s.detachedRuns} detached`]);
  }

  return alignPairs(pairs);
}

// ---------------------------------------------------------------------------
// /config
// ---------------------------------------------------------------------------

/** Declaration order of TuiConfig fields, used for stable /config output. */
const CONFIG_KEY_ORDER: ReadonlyArray<keyof TuiConfig> = [
  "apiKey",
  "model",
  "baseUrl",
  "runtimeBin",
  "commandAllowlist",
  "permissionRules",
  "mcpServers",
  "hooks",
  "accent",
  "bell",
  "notify",
  "vim",
  "sandbox",
  "statusLine",
  "costBudgetUsd",
  "thinking",
  "reasoningEffort",
];

/** "sk-…last4" redaction; very short keys fall back to a full mask. */
function redactKey(apiKey: string): string {
  return apiKey.length > 8 ? `sk-…${apiKey.slice(-4)}` : "sk-…";
}

/** Stage names that actually have hooks configured, in declaration order. */
function configuredStages(hooks: TuiConfig["hooks"]): string[] {
  return Object.entries(hooks ?? {})
    .filter(([, entries]) => (entries?.length ?? 0) > 0)
    .map(([stage]) => stage);
}

/** Summarized display value for one defined TuiConfig field. */
function configValue(key: keyof TuiConfig, config: TuiConfig): string {
  switch (key) {
    case "apiKey":
      return redactKey(config.apiKey ?? "");
    case "commandAllowlist": {
      const n = config.commandAllowlist?.length ?? 0;
      return `${n} ${n === 1 ? "entry" : "entries"}`;
    }
    case "permissionRules": {
      const n = config.permissionRules?.length ?? 0;
      return `${n} ${n === 1 ? "rule" : "rules"}`;
    }
    case "mcpServers": {
      const n = Object.keys(config.mcpServers ?? {}).length;
      return `${n} ${n === 1 ? "server" : "servers"}`;
    }
    case "hooks":
      return `stages ${configuredStages(config.hooks).join(",")}`;
    default:
      return String(config[key]);
  }
}

/**
 * "key = value" per defined field in declaration order, with the apiKey
 * redacted and object fields summarized, followed by footer lines naming
 * both config paths and the /config edit hint.
 */
export function formatConfigLines(config: TuiConfig, paths: { global: string; project: string }): string[] {
  const lines = CONFIG_KEY_ORDER.filter((key) => config[key] !== undefined).map(
    (key) => `${key} = ${configValue(key, config)}`,
  );
  if (lines.length === 0) lines.push("(no settings configured — using defaults)");
  lines.push(`global:  ${paths.global}`);
  lines.push(`project: ${paths.project}`);
  lines.push("/config edit opens the global file");
  return lines;
}

// ---------------------------------------------------------------------------
// /permissions
// ---------------------------------------------------------------------------

export type PermissionSurfaceInput = {
  rules: ReadonlyArray<{ action: string; tool: string; match?: string }>;
  /** BUILTIN_COMMAND_ALLOWLIST from @seekforge/core; summarized to ~10. */
  builtinAllowlist: readonly string[];
  configAllowlist: readonly string[];
  /** Entries added at runtime via the permission panel's "a". */
  sessionAllowlist: readonly string[];
  sandbox?: string;
  approval: string;
};

/** "deny run_command(rm *)" — action tool(match), match omitted when absent. */
function formatRule(rule: { action: string; tool: string; match?: string }): string {
  return rule.match !== undefined ? `${rule.action} ${rule.tool}(${rule.match})` : `${rule.action} ${rule.tool}`;
}

const BUILTIN_PREVIEW = 10;

/**
 * Sections for /permissions: approval mode + sandbox level, the allow/deny
 * rules, then the builtin (summarized), config and session allowlists —
 * each with an explicit empty-state line.
 */
export function formatPermissionLines(p: PermissionSurfaceInput): string[] {
  const lines: string[] = [`approval mode: ${p.approval}`, `sandbox: ${p.sandbox ?? "off"}`];

  if (p.rules.length === 0) {
    lines.push("rules: none configured (permissionRules in config)");
  } else {
    lines.push(`rules (${p.rules.length}):`);
    for (const rule of p.rules) lines.push(`  ${formatRule(rule)}`);
  }

  const shown = p.builtinAllowlist.slice(0, BUILTIN_PREVIEW);
  const rest = p.builtinAllowlist.length - shown.length;
  lines.push(
    p.builtinAllowlist.length === 0
      ? "builtin allowlist: (empty)"
      : `builtin allowlist: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`,
  );

  lines.push(
    p.configAllowlist.length === 0
      ? "config allowlist: (none — commandAllowlist in config)"
      : `config allowlist: ${p.configAllowlist.join(", ")}`,
  );
  lines.push(
    p.sessionAllowlist.length === 0
      ? 'session allowlist: (none — press "a" on a permission prompt to add)'
      : `session allowlist: ${p.sessionAllowlist.join(", ")}`,
  );

  return lines;
}

// ---------------------------------------------------------------------------
// /hooks
// ---------------------------------------------------------------------------

/** HookConfig declaration order; payload table lives in @seekforge/core. */
const HOOK_STAGE_ORDER = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
  "sessionEnd",
] as const;

/** Stages where a non-zero hook exit blocks the tool call / run. */
const BLOCKING_STAGES: ReadonlySet<string> = new Set(["preToolUse", "userPromptSubmit"]);

/**
 * One line per configured hook — "preToolUse (blocking): <command>" with the
 * command capped to 60 chars — in stage declaration order; an explainer with
 * a config example when nothing is configured.
 */
export function formatHookLines(hooks: TuiConfig["hooks"]): string[] {
  const lines: string[] = [];
  for (const stage of HOOK_STAGE_ORDER) {
    const entries: HookEntry[] = hooks?.[stage] ?? [];
    const blocking = BLOCKING_STAGES.has(stage) ? " (blocking)" : "";
    for (const entry of entries) {
      lines.push(`${stage}${blocking}: ${cap(entry.command, 60)}`);
    }
  }
  if (lines.length === 0) {
    return [
      "no hooks configured",
      'add "hooks" to .seekforge/config.json, e.g. { "hooks": { "preToolUse": [{ "command": "./lint-gate.sh" }] } }',
      "blocking stages (non-zero exit blocks): preToolUse, userPromptSubmit",
    ];
  }
  return lines;
}

// ---------------------------------------------------------------------------
// /release-notes
// ---------------------------------------------------------------------------

export type ChangelogSection = { heading: string; lines: string[] };

const CHANGELOG_BODY_CAP = 40;
const CHANGELOG_WALK_LEVELS = 4;

/** Parses the first "## " section (heading + body, body capped to 40 lines). */
function parseFirstSection(text: string): ChangelogSection | null {
  const all = text.split(/\r?\n/);
  const start = all.findIndex((line) => line.startsWith("## "));
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < all.length && body.length < CHANGELOG_BODY_CAP; i++) {
    const line = all[i] as string;
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  while (body.length > 0 && body[body.length - 1]?.trim() === "") body.pop();
  return { heading: (all[start] as string).slice(3).trim(), lines: body };
}

/**
 * Finds the nearest CHANGELOG.md by walking each start dir upward (at most
 * 4 parent levels) and returns its first "## " section, or null. Read-only
 * fs access; never throws on unreadable files.
 */
export function findChangelogSection(startDirs: readonly string[]): ChangelogSection | null {
  for (const start of startDirs) {
    let dir = start;
    for (let level = 0; level <= CHANGELOG_WALK_LEVELS; level++) {
      const candidate = join(dir, "CHANGELOG.md");
      if (existsSync(candidate)) {
        try {
          const section = parseFirstSection(readFileSync(candidate, "utf8"));
          if (section) return section;
        } catch {
          // unreadable file — keep walking
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Heading + body lines for the section, or a one-line fallback pointing at
 * the hosted CHANGELOG when none was found.
 */
export function formatReleaseNotes(section: ChangelogSection | null, version?: string): string[] {
  if (!section) {
    const label = version ? `version ${version}` : "SeekForge";
    return [`${label} — see ${CHANGELOG_URL}`];
  }
  return [section.heading, ...section.lines];
}

// ---------------------------------------------------------------------------
// /bug
// ---------------------------------------------------------------------------

export type BugReportInput = {
  version?: string;
  platform: string;
  nodeVersion: string;
  model: string;
  /** Pre-rendered formatDoctorLines output. */
  doctorLines: readonly string[];
  lastError?: string;
};

/**
 * One markdown document for /bug: environment table, doctor output, the last
 * error (when any), placeholder sections to fill in, and the issues URL.
 */
export function buildBugReport(b: BugReportInput): string {
  const parts: string[] = [
    "## SeekForge bug report",
    "",
    "| field | value |",
    "| --- | --- |",
    `| version | ${b.version ?? "unknown"} |`,
    `| platform | ${b.platform} |`,
    `| node | ${b.nodeVersion} |`,
    `| model | ${b.model} |`,
    "",
    "### Doctor",
    "",
    "```",
    ...b.doctorLines,
    "```",
  ];
  if (b.lastError) {
    parts.push("", "### Last error", "", "```", b.lastError, "```");
  }
  parts.push(
    "",
    "### What happened",
    "",
    "(describe the bug)",
    "",
    "### Expected",
    "",
    "(what you expected instead)",
    "",
    `Open an issue: ${ISSUES_URL}`,
  );
  return parts.join("\n");
}
