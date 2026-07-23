import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { compileGlob } from "../tools/builtins/glob.js";
import { readSkillEffectiveness } from "./usage.js";
import type { Skill, SkillSelection } from "./types.js";

export type SelectSkillsOptions = {
  workspace?: string;
  max?: number;
  allowHighRisk?: boolean;
  /** Disable local historical weighting for controlled evaluations. */
  useFeedback?: boolean;
};

const SCORE_PER_TRIGGER = 4;
const SCORE_PER_TAG = 2;
const SCORE_FRAMEWORK = 2;
const SCORE_LANGUAGE = 2;
const SCORE_FILE_PATTERN = 2;
const SCORE_TASK_TYPE = 2.5;
const MAX_LEXICAL_SCORE = 3;
const MAX_SEMANTIC_SCORE = 1.5;

const KNOWN_FRAMEWORKS = ["vue", "react", "next", "nuxt", "vite", "express"];
const MAX_WORKSPACE_PATHS = 5_000;
const MAX_SIGNAL_CACHE_ENTRIES = 16;
const IGNORE_DIRS = new Set([".git", ".seekforge", "node_modules", "dist", "build", "coverage", "target"]);

type DirectoryIdentity = { path: string; mtimeMs: number; ctimeMs: number; size: number; ino: number };
type WorkspaceSignals = { languages: string[]; paths: string[]; frameworks: string[] };
type SignalCacheEntry = { signals: WorkspaceSignals; directories: DirectoryIdentity[]; packageIdentity?: string };
const signalCache = new Map<string, SignalCacheEntry>();

function fileIdentity(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function cacheValid(entry: SignalCacheEntry, root: string): boolean {
  if (entry.packageIdentity !== fileIdentity(path.join(root, "package.json"))) return false;
  return entry.directories.every((identity) => {
    try {
      const stat = fs.lstatSync(identity.path);
      return (
        !stat.isSymbolicLink() &&
        stat.isDirectory() &&
        stat.ino === identity.ino &&
        stat.mtimeMs === identity.mtimeMs &&
        stat.ctimeMs === identity.ctimeMs &&
        stat.size === identity.size
      );
    } catch {
      return false;
    }
  });
}

function detectPackageFrameworks(root: string): string[] {
  try {
    const packageFile = path.join(root, "package.json");
    const stat = fs.lstatSync(packageFile);
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
    const raw = JSON.parse(readUtf8FileBoundedSync(packageFile, 1024 * 1024)) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const deps: Record<string, unknown> = {};
    for (const key of ["dependencies", "devDependencies"]) {
      const value = record[key];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) Object.assign(deps, value);
    }
    return KNOWN_FRAMEWORKS.filter((framework) => framework in deps);
  } catch {
    return [];
  }
}

function detectWorkspaceSignals(workspace: string): WorkspaceSignals {
  const root = fs.realpathSync(workspace);
  const cached = signalCache.get(root);
  if (cached && cacheValid(cached, root)) {
    signalCache.delete(root);
    signalCache.set(root, cached);
    return cached.signals;
  }
  const paths: string[] = [];
  const extensions = new Set<string>();
  const directories: DirectoryIdentity[] = [];
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  while (stack.length > 0 && paths.length < MAX_WORKSPACE_PATHS) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      const stat = fs.lstatSync(current.absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      directories.push({
        path: current.absolute,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        ino: stat.ino,
      });
      entries = fs.readdirSync(current.absolute, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_WORKSPACE_PATHS) break;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          stack.push({ absolute: path.join(current.absolute, entry.name), relative });
        }
      } else if (entry.isFile()) {
        paths.push(relative);
        extensions.add(path.extname(entry.name).toLowerCase());
      }
    }
  }
  const names = new Set(paths);
  const languages: string[] = [];
  if (extensions.has(".ts") || extensions.has(".tsx") || names.has("tsconfig.json")) languages.push("typescript");
  else if (extensions.has(".js") || extensions.has(".jsx") || extensions.has(".mjs")) languages.push("javascript");
  if (extensions.has(".rs") || names.has("Cargo.toml")) languages.push("rust");
  if (extensions.has(".py") || names.has("pyproject.toml")) languages.push("python");
  if (extensions.has(".go") || names.has("go.mod")) languages.push("go");
  if (extensions.has(".java") || names.has("pom.xml") || names.has("build.gradle")) languages.push("java");
  const signals = { languages, paths, frameworks: detectPackageFrameworks(root) };
  signalCache.set(root, { signals, directories, packageIdentity: fileIdentity(path.join(root, "package.json")) });
  while (signalCache.size > MAX_SIGNAL_CACHE_ENTRIES) signalCache.delete(signalCache.keys().next().value!);
  return signals;
}

/** Test/diagnostic seam; normal invalidation is identity-based. */
export function clearSkillSignalCache(): void {
  signalCache.clear();
}

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function taskIncludes(task: string, term: string): boolean {
  if (!/[a-z0-9]/i.test(term) || /[^a-z0-9 _-]/i.test(term)) return task.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ _-]+/g, "[ _-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(task);
}

function tokens(text: string): string[] {
  const lower = text.toLowerCase();
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "thing",
    "description",
    "procedure",
    "verification",
  ]);
  const latin = (lower.match(/[a-z0-9][a-z0-9_-]{1,31}/g) ?? []).filter((token) => !stopwords.has(token));
  const cjkRuns = lower.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const cjk = cjkRuns.flatMap((run) => {
    const chars = [...run];
    return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
  });
  return [...new Set([...latin, ...cjk])].slice(0, 128);
}

function taskTypes(task: string): string[] {
  const definitions: Array<[string, string[]]> = [
    ["bugfix", ["bug", "fix", "error", "crash", "报错", "修复", "问题"]],
    ["test", ["test", "regression", "coverage", "测试", "回归"]],
    ["docs", ["docs", "documentation", "readme", "文档"]],
    ["security", ["security", "vulnerability", "permission", "安全", "漏洞", "权限"]],
    ["performance", ["performance", "optimize", "cache", "性能", "优化", "缓存"]],
    ["refactor", ["refactor", "cleanup", "重构", "整理"]],
    ["feature", ["feature", "implement", "add", "功能", "新增", "实现"]],
  ];
  return definitions.filter(([, terms]) => terms.some((term) => taskIncludes(task, term))).map(([type]) => type);
}

function lexicalScores(task: string, skills: readonly Skill[]): Map<string, number> {
  const query = tokens(task);
  if (query.length === 0 || skills.length === 0) return new Map();
  const documents = skills.map((skill) =>
    tokens(`${skill.id} ${skill.name} ${skill.description} ${skill.tags.join(" ")} ${skill.content.slice(0, 8_000)}`),
  );
  const frequencies = new Map<string, number>();
  for (const document of documents)
    for (const token of new Set(document)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const scores = new Map<string, number>();
  for (let index = 0; index < skills.length; index++) {
    const document = new Set(documents[index]);
    let score = 0;
    for (const token of query) {
      if (!document.has(token)) continue;
      score += Math.log(1 + (skills.length + 0.5) / ((frequencies.get(token) ?? 0) + 0.5));
    }
    if (score > 0) scores.set(skills[index]!.id, Math.min(MAX_LEXICAL_SCORE, score));
  }
  return scores;
}

function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 2_000);
  const result = new Set<string>();
  for (let index = 0; index + 2 < normalized.length; index++) result.add(normalized.slice(index, index + 3));
  return result;
}

function semanticScore(task: string, skill: Skill): number {
  const left = trigrams(task);
  const right = trigrams(`${skill.name} ${skill.description}`);
  if (left.size < 2 || right.size < 2) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap++;
  const similarity = overlap / Math.sqrt(left.size * right.size);
  return similarity >= 0.12 ? Math.min(MAX_SEMANTIC_SCORE, similarity * 4) : 0;
}

function orchestrate(
  ranked: SkillSelection[],
  allSkills: readonly Skill[],
  limit: number,
  allowHighRisk: boolean,
): SkillSelection[] {
  const available = new Map(allSkills.map((skill) => [skill.id, skill]));
  const selected = new Map<string, SkillSelection>();
  const conflicts = (skill: Skill, ids: ReadonlySet<string>): boolean =>
    (skill.conflictsWith ?? []).some((id) => ids.has(id)) ||
    [...ids].some((id) => available.get(id)?.conflictsWith?.includes(skill.id));

  for (const candidate of ranked) {
    const bundle: SkillSelection[] = [];
    const visiting = new Set<string>();
    const bundleIds = new Set<string>();
    let valid = true;
    const visit = (skill: Skill): void => {
      if (!valid || selected.has(skill.id) || bundleIds.has(skill.id)) return;
      if (visiting.has(skill.id) || (skill.risk === "high" && !allowHighRisk)) {
        valid = false;
        return;
      }
      visiting.add(skill.id);
      for (const dependencyId of skill.dependsOn ?? []) {
        const dependency = available.get(dependencyId);
        if (!dependency) {
          valid = false;
          break;
        }
        visit(dependency);
      }
      visiting.delete(skill.id);
      if (!valid) return;
      bundleIds.add(skill.id);
      bundle.push(
        skill.id === candidate.skill.id
          ? candidate
          : { skill, score: candidate.score, reason: `dependency of ${candidate.skill.id}` },
      );
    };
    visit(candidate.skill);
    const combinedIds = new Set([...selected.keys(), ...bundleIds]);
    if (!valid || selected.size + bundle.length > limit || bundle.some(({ skill }) => conflicts(skill, combinedIds)))
      continue;
    for (const selection of bundle) selected.set(selection.skill.id, selection);
    if (selected.size >= limit) break;
  }

  const pending = new Map(selected);
  const ordered: SkillSelection[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter(({ skill }) => (skill.dependsOn ?? []).every((id) => !pending.has(id)))
      .sort(
        (a, b) =>
          (a.skill.order ?? 0) - (b.skill.order ?? 0) || b.score - a.score || a.skill.id.localeCompare(b.skill.id),
      );
    if (ready.length === 0) return [];
    for (const selection of ready) {
      ordered.push(selection);
      pending.delete(selection.skill.id);
    }
  }
  return ordered;
}

/** Hybrid deterministic selection with negative rules, task typing, local feedback, and orchestration. */
export function selectSkills(task: string, skills: Skill[], opts?: SelectSkillsOptions): SkillSelection[] {
  const limit = opts?.max ?? DEFAULT_LIMITS.maxActiveSkills;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64) {
    throw new RangeError("skill selection max must be a safe integer between 0 and 64");
  }
  if (limit === 0) return [];
  const taskLower = task.toLowerCase();
  const signals = opts?.workspace
    ? detectWorkspaceSignals(opts.workspace)
    : { languages: [], paths: [], frameworks: [] };
  const inferredTypes = taskTypes(taskLower);
  const lexical = lexicalScores(taskLower, skills);
  const feedback = new Map(
    opts?.workspace && opts.useFeedback !== false
      ? readSkillEffectiveness(opts.workspace).map((stats) => [stats.skillId, stats.learnedAdjustment])
      : [],
  );

  const selections: SkillSelection[] = [];
  for (const skill of skills) {
    if (skill.risk === "high" && opts?.allowHighRisk !== true) continue;
    const negative = normalizedUnique(skill.negativeTriggers ?? []).find((term) => taskIncludes(taskLower, term));
    if (negative) continue;
    let score = 0;
    const reasons: string[] = [];
    for (const trigger of normalizedUnique(skill.triggers)) {
      if (taskIncludes(taskLower, trigger)) {
        score += SCORE_PER_TRIGGER;
        reasons.push(`trigger "${trigger}"`);
      }
    }
    for (const tag of normalizedUnique(skill.tags)) {
      if (taskIncludes(taskLower, tag)) {
        score += SCORE_PER_TAG;
        reasons.push(`tag ${tag}`);
      }
    }
    const typeHit = normalizedUnique(skill.taskTypes ?? []).find((type) => inferredTypes.includes(type));
    if (typeHit) {
      score += SCORE_TASK_TYPE;
      reasons.push(`task ${typeHit}`);
    }
    const frameworkHit = normalizedUnique(skill.appliesTo?.frameworks ?? []).find((value) =>
      signals.frameworks.includes(value),
    );
    if (frameworkHit) {
      score += SCORE_FRAMEWORK;
      reasons.push(`framework ${frameworkHit}`);
    }
    const languageHit = normalizedUnique(skill.appliesTo?.languages ?? []).find((value) =>
      signals.languages.includes(value),
    );
    if (languageHit) {
      score += SCORE_LANGUAGE;
      reasons.push(`language ${languageHit}`);
    }
    for (const pattern of [...new Set(skill.appliesTo?.filePatterns ?? [])]) {
      try {
        if (signals.paths.some((candidate) => compileGlob(pattern).test(candidate))) {
          score += SCORE_FILE_PATTERN;
          reasons.push(`file ${pattern}`);
          break;
        }
      } catch {
        // Invalid patterns do not participate in automatic selection.
      }
    }
    // Retrieval is a fallback for skills without an explicit metadata/workspace
    // match, so rich content cannot overpower deliberate triggers.
    if (score === 0) {
      const lexicalScore = lexical.get(skill.id) ?? 0;
      const semantic = semanticScore(taskLower, skill);
      if (lexicalScore > 0) {
        score += lexicalScore;
        reasons.push("lexical match");
      }
      if (semantic > 0) {
        score += semantic;
        reasons.push("semantic match");
      }
    }
    if (score <= 0) continue;
    const adjustment = feedback.get(skill.id) ?? 0;
    selections.push({
      skill,
      score: score + skill.priority / 100 + adjustment,
      reason: reasons.join("; "),
      ...(adjustment !== 0 ? { feedbackAdjustment: adjustment } : {}),
    });
  }
  selections.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return orchestrate(selections, skills, limit, opts?.allowHighRisk === true);
}
