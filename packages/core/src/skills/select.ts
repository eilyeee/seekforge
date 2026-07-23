import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { compileGlob } from "../tools/builtins/glob.js";
import type { Skill, SkillSelection } from "./types.js";

export type SelectSkillsOptions = {
  /** Used to detect frameworks from package.json for appliesTo matching. */
  workspace?: string;
  /** Max selections, default 3 (DEFAULT_LIMITS.maxActiveSkills). */
  max?: number;
  /** High-risk skills are never auto-selected unless the caller explicitly opts in. */
  allowHighRisk?: boolean;
};

const SCORE_PER_TRIGGER = 4;
const SCORE_PER_TAG = 2;
const SCORE_FRAMEWORK = 2;
const SCORE_LANGUAGE = 2;
const SCORE_FILE_PATTERN = 2;

const KNOWN_FRAMEWORKS = ["vue", "react", "next", "nuxt", "vite", "express"];
const MAX_WORKSPACE_PATHS = 5_000;
const IGNORE_DIRS = new Set([".git", ".seekforge", "node_modules", "dist", "build", "coverage", "target"]);

type WorkspaceSignals = { languages: string[]; paths: string[] };

/** Frameworks present as dependencies in <workspace>/package.json. */
function detectPackageFrameworks(workspace: string): string[] {
  try {
    const packageFile = path.join(fs.realpathSync(workspace), "package.json");
    const stat = fs.lstatSync(packageFile);
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
    const raw = JSON.parse(readUtf8FileBoundedSync(packageFile, 1024 * 1024)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...raw.dependencies, ...raw.devDependencies };
    return KNOWN_FRAMEWORKS.filter((fw) => fw in deps);
  } catch {
    return [];
  }
}

function detectWorkspaceSignals(workspace: string): WorkspaceSignals {
  const root = fs.realpathSync(workspace);
  const paths: string[] = [];
  const extensions = new Set<string>();
  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  while (stack.length > 0 && paths.length < MAX_WORKSPACE_PATHS) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
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
  return { languages, paths };
}

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function taskIncludes(task: string, term: string): boolean {
  if (!/[a-z0-9]/i.test(term) || /[^a-z0-9 _-]/i.test(term)) return task.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ _-]+/g, "[ _-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(task);
}

/**
 * Rule-based selection: triggers > tags/keywords > frameworks > priority.
 * Only skills with a positive match score qualify; priority is a tie-breaker
 * only. Equal scores order deterministically by id.
 */
export function selectSkills(task: string, skills: Skill[], opts?: SelectSkillsOptions): SkillSelection[] {
  const limit = opts?.max ?? DEFAULT_LIMITS.maxActiveSkills;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64) {
    throw new RangeError("skill selection max must be a safe integer between 0 and 64");
  }
  const taskLower = task.toLowerCase();
  let frameworks: string[] | undefined;
  const detectedFrameworks = (): string[] => {
    frameworks ??= opts?.workspace ? detectPackageFrameworks(opts.workspace) : [];
    return frameworks;
  };
  let workspaceSignals: WorkspaceSignals | undefined;
  const signals = (): WorkspaceSignals => {
    workspaceSignals ??= opts?.workspace ? detectWorkspaceSignals(opts.workspace) : { languages: [], paths: [] };
    return workspaceSignals;
  };

  const selections: SkillSelection[] = [];
  for (const skill of skills) {
    if (skill.risk === "high" && opts?.allowHighRisk !== true) continue;
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
    const wantedFrameworks = normalizedUnique(skill.appliesTo?.frameworks ?? []);
    if (wantedFrameworks.length > 0) {
      const hit = wantedFrameworks.find((framework) => detectedFrameworks().includes(framework));
      if (hit) {
        score += SCORE_FRAMEWORK;
        reasons.push(`framework ${hit}`);
      }
    }
    const wantedLanguages = normalizedUnique(skill.appliesTo?.languages ?? []);
    if (wantedLanguages.length > 0) {
      const hit = wantedLanguages.find((language) => signals().languages.includes(language));
      if (hit) {
        score += SCORE_LANGUAGE;
        reasons.push(`language ${hit}`);
      }
    }
    for (const pattern of [...new Set(skill.appliesTo?.filePatterns ?? [])]) {
      let matcher: RegExp;
      try {
        matcher = compileGlob(pattern);
      } catch {
        continue;
      }
      const hit = signals().paths.find((candidate) => matcher.test(candidate));
      if (hit) {
        score += SCORE_FILE_PATTERN;
        reasons.push(`file ${pattern}`);
        break;
      }
    }
    if (score <= 0) continue;
    selections.push({
      skill,
      score: score + skill.priority / 100,
      reason: reasons.join("; "),
    });
  }

  selections.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return selections.slice(0, limit);
}
