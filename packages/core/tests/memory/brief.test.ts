import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryBrief, readProjectMemory } from "../../src/memory/index.js";
import {
  clearGlobalMemory,
  makeWorkspace,
  writeGlobalMemory,
  writeProjectMemory,
  writeSubdirMemory,
  writeWorkspaceFile,
} from "./helpers.js";

const STALE_WARNING = "Remembered facts from earlier sessions — may be stale; verify before relying on them.";

/** Bullet lines of a brief (header stripped). */
function bullets(brief: string | undefined): string[] {
  if (brief === undefined) return [];
  return brief.split("\n").slice(1);
}

describe("readProjectMemory", () => {
  it("returns undefined when project.md does not exist", () => {
    expect(readProjectMemory(makeWorkspace())).toBeUndefined();
  });

  it("returns the full text when project.md exists", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] uses vitest\n");
    expect(readProjectMemory(ws)).toBe("# Project Memory\n- [tech] uses vitest\n");
  });
});

describe("buildMemoryBrief", () => {
  it("returns undefined when project.md is absent or empty", () => {
    expect(buildMemoryBrief(makeWorkspace(), "any task")).toBeUndefined();
    const ws = makeWorkspace();
    writeProjectMemory(ws, "   \n");
    expect(buildMemoryBrief(ws, "any task")).toBeUndefined();
  });

  it("starts every non-empty brief with the stale-memory warning line", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [command] verify with pnpm test\n");
    const brief = buildMemoryBrief(ws, "anything at all");
    expect(brief).toBeDefined();
    expect(brief!.split("\n")[0]).toBe(STALE_WARNING);
  });

  it("ranks a path-token match above generic keyword overlap", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] fix bug reports via the issue tracker workflow",
        "- [path] src/login.ts contains the login form and its submit handler",
        "",
      ].join("\n"),
    );
    const brief = buildMemoryBrief(ws, "fix the bug in src/login.ts");
    // The path fact shares "src/login.ts" with the task: highest relevance.
    expect(bullets(brief)[0]).toBe("- [path] src/login.ts contains the login form and its submit handler");
  });

  it("boosts adjacent-word bigram phrase matches over bare unigram overlap", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] validation of login forms happens in separate middleware modules",
        "- [convention] login validation uses zod schemas shared with the API",
        "",
      ].join("\n"),
    );
    const brief = buildMemoryBrief(ws, "improve login validation flow");
    const lines = bullets(brief);
    // Both contain "login" + "validation", but only one has the exact phrase.
    expect(lines[0]).toBe("- [convention] login validation uses zod schemas shared with the API");
    expect(lines[1]).toBe("- [convention] validation of login forms happens in separate middleware modules");
  });

  it("breaks score ties by recency: later project.md lines first", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] login validation via zod",
        "- [convention] login validation in middleware",
        "",
      ].join("\n"),
    );
    const lines = bullets(buildMemoryBrief(ws, "improve login validation"));
    expect(lines[0]).toBe("- [convention] login validation in middleware");
    expect(lines[1]).toBe("- [convention] login validation via zod");
  });

  it("matches Chinese tasks via CJK bigrams", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] 登录表单的校验逻辑放在 src/validators 目录",
        "- [path] unrelated docs live in docs/",
        "",
      ].join("\n"),
    );
    const brief = buildMemoryBrief(ws, "修复登录校验问题");
    expect(brief).toBeDefined();
    expect(brief).toContain("登录表单的校验逻辑");
    // Small corpus → both facts injected; the CJK-matched one ranks first.
    expect(bullets(brief)[0]).toContain("登录表单的校验逻辑");
  });

  it("small corpus: injects every fact even on weak/no overlap (recall > filtering)", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [task_pattern] retry logic lives behind a feature flag",
        "- [convention] components use kebab-case filenames",
        "",
      ].join("\n"),
    );
    // A handful of curated facts are all injected — no relevance floor.
    const brief = buildMemoryBrief(ws, "refactor websocket reconnect logic");
    expect(brief).toBeDefined();
    expect(brief).toContain("retry logic lives behind a feature flag");
    expect(brief).toContain("kebab-case");
  });

  it("large corpus: a fully unrelated task yields no brief (floor drops weak matches)", () => {
    const ws = makeWorkspace();
    // >SMALL_CORPUS facts, none [command]/[tech], none overlapping the task.
    const facts = Array.from(
      { length: 25 },
      (_, i) => `- [convention] styling convention number ${i} about component class names`,
    );
    writeProjectMemory(ws, `# Project Memory\n${facts.join("\n")}\n`);
    expect(buildMemoryBrief(ws, "upgrade the docker base image")).toBeUndefined();
  });

  it("large corpus: always includes [command]/[tech]; drops below-floor others", () => {
    const ws = makeWorkspace();
    const filler = Array.from(
      { length: 22 },
      (_, i) => `- [convention] filler convention ${i} about kebab-case filenames`,
    );
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [command] verify with pnpm typecheck && pnpm test",
        "- [tech] monorepo managed by pnpm workspaces",
        ...filler,
        "",
      ].join("\n"),
    );
    const brief = buildMemoryBrief(ws, "完全不相关的任务");
    expect(brief).toBeDefined();
    expect(brief).toContain("- [command] verify with pnpm typecheck && pnpm test");
    expect(brief).toContain("- [tech] monorepo managed by pnpm workspaces");
    // Below-floor non-always-include types are excluded once the corpus is large.
    expect(brief).not.toContain("filler convention");
  });

  it("caps the brief at 12 bullets plus the warning line", () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 30 }, (_, i) => `- [command] command number ${i}`);
    writeProjectMemory(ws, `# Project Memory\n${lines.join("\n")}\n`);
    const brief = buildMemoryBrief(ws, "anything");
    expect(brief!.split("\n")).toHaveLength(13);
    expect(brief!.split("\n")[0]).toBe(STALE_WARNING);
  });

  it("caps the total brief (header included) at 1200 characters", () => {
    const ws = makeWorkspace();
    const long = "x".repeat(400);
    const factLines = Array.from({ length: 10 }, (_, i) => `- [tech] ${i} ${long}`);
    writeProjectMemory(ws, `# Project Memory\n${factLines.join("\n")}\n`);
    const brief = buildMemoryBrief(ws, "anything");
    expect(brief!.length).toBeLessThanOrEqual(1200);
    expect(bullets(brief).length).toBeGreaterThan(0);
  });

  it("returns undefined when no bullet fits under the size cap", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, `# Project Memory\n- [tech] ${"y".repeat(1300)}\n`);
    expect(buildMemoryBrief(ws, "anything")).toBeUndefined();
  });

  it("is deterministic given fixed inputs", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [command] verify with pnpm test",
        "- [path] login form lives in src/login.ts",
        "- [convention] login validation uses zod schemas",
        "",
      ].join("\n"),
    );
    const task = "fix login validation in src/login.ts";
    const first = buildMemoryBrief(ws, task);
    const second = buildMemoryBrief(ws, task);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe("buildMemoryBrief: global (cross-project) memory merge", () => {
  afterEach(() => {
    clearGlobalMemory();
  });

  it("merges global facts with project facts in the brief", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [path] login form lives in src/login.ts\n");
    writeGlobalMemory("# Global Memory\n- [convention] always run login validation through shared zod schemas\n");
    const brief = buildMemoryBrief(ws, "fix login validation in src/login.ts");
    expect(brief).toBeDefined();
    expect(brief).toContain("src/login.ts");
    expect(brief).toContain("shared zod schemas");
  });

  it("builds a brief from global facts even when the project has none", () => {
    const ws = makeWorkspace(); // no project.md
    writeGlobalMemory("# Global Memory\n- [convention] login validation uses zod\n");
    const brief = buildMemoryBrief(ws, "improve login validation");
    expect(brief).toBeDefined();
    expect(brief).toContain("login validation uses zod");
  });

  it("dedupes identical bullets across project and global (project wins)", () => {
    const ws = makeWorkspace();
    const bullet = "- [convention] login validation uses zod schemas";
    writeProjectMemory(ws, `# Project Memory\n${bullet}\n`);
    writeGlobalMemory(`# Global Memory\n${bullet}\n`);
    const brief = buildMemoryBrief(ws, "improve login validation");
    expect(brief).toBeDefined();
    // The bullet appears exactly once despite being in both files.
    expect(bullets(brief).filter((l) => l === bullet)).toHaveLength(1);
  });

  it("ranks a project fact at least as high as a global one on equal score", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [convention] login validation in project\n");
    writeGlobalMemory("# Global Memory\n- [convention] login validation in global\n");
    const lines = bullets(buildMemoryBrief(ws, "improve login validation"));
    // Equal lexical score → project wins precedence.
    expect(lines[0]).toBe("- [convention] login validation in project");
  });

  it("does NOT blanket-include global [command]/[tech]; only project ones are always-included", () => {
    const ws = makeWorkspace();
    // Large project corpus so the relevance floor (not small-corpus) applies.
    const filler = Array.from(
      { length: 22 },
      (_, i) => `- [convention] filler convention ${i} about kebab-case filenames`,
    );
    writeProjectMemory(
      ws,
      ["# Project Memory", "- [command] verify with pnpm typecheck && pnpm test", ...filler, ""].join("\n"),
    );
    writeGlobalMemory("# Global Memory\n- [command] some unrelated global deploy command for another repo\n");
    const brief = buildMemoryBrief(ws, "完全不相关的任务");
    expect(brief).toBeDefined();
    // Project command is always-included...
    expect(brief).toContain("- [command] verify with pnpm typecheck && pnpm test");
    // ...but the global command is NOT (relevance-only → below floor → dropped).
    expect(brief).not.toContain("unrelated global deploy command");
  });
});

describe("buildMemoryBrief: subdirectory memory cascade (monorepo per-package facts)", () => {
  it("surfaces a subdir fact for a task referencing that subdir's path", () => {
    const ws = makeWorkspace();
    // Enough root facts that the corpus is large → relevance floor applies, so a
    // surfaced subdir fact must clear the floor on its own (via the path boost).
    const filler = Array.from(
      { length: 22 },
      (_, i) => `- [convention] filler convention ${i} about kebab-case filenames`,
    );
    writeProjectMemory(ws, `# Project Memory\n${filler.join("\n")}\n`);
    writeSubdirMemory(ws, "packages/api", "# API Memory\n- [path] the api server bootstrap lives in main entry\n");
    const brief = buildMemoryBrief(ws, "fix a bug in packages/api startup");
    expect(brief).toBeDefined();
    // The task path "packages/api" matches the subdir's relDir (path-token boost),
    // so the subdir fact clears the floor and is injected.
    expect(brief).toContain("the api server bootstrap lives in main entry");
  });

  it("merges subdir facts into a small corpus alongside root + global", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] root uses pnpm workspaces\n");
    writeSubdirMemory(ws, "packages/web", "# Web Memory\n- [convention] web package uses tailwind for styling\n");
    const brief = buildMemoryBrief(ws, "anything at all");
    expect(brief).toBeDefined();
    expect(brief).toContain("root uses pnpm workspaces");
    expect(brief).toContain("web package uses tailwind for styling");
  });

  it("skips memory files under node_modules and .git", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] root fact\n");
    // Plant decoy memory files inside excluded dirs — must never be scanned.
    writeWorkspaceFile(
      ws,
      "node_modules/somedep/.seekforge/memory/project.md",
      "# Dep Memory\n- [tech] poisoned node_modules fact\n",
    );
    writeWorkspaceFile(ws, ".git/hooks/.seekforge/memory/project.md", "# Git Memory\n- [tech] poisoned git fact\n");
    const brief = buildMemoryBrief(ws, "anything at all");
    expect(brief).toBeDefined();
    expect(brief).toContain("root fact");
    expect(brief).not.toContain("poisoned node_modules fact");
    expect(brief).not.toContain("poisoned git fact");
  });

  it("root project fact wins an identical-line dedup against a subdir copy", () => {
    const ws = makeWorkspace();
    const bullet = "- [convention] login validation uses zod schemas";
    writeProjectMemory(ws, `# Project Memory\n${bullet}\n`);
    writeSubdirMemory(ws, "packages/api", `# API Memory\n${bullet}\n`);
    const brief = buildMemoryBrief(ws, "improve login validation");
    expect(brief).toBeDefined();
    // Appears exactly once despite being in both files.
    expect(bullets(brief).filter((l) => l === bullet)).toHaveLength(1);
  });

  it("ranks a root project fact above a subdir fact on equal score", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [convention] login validation in root\n");
    writeSubdirMemory(ws, "packages/api", "# API Memory\n- [convention] login validation in subdir\n");
    const lines = bullets(buildMemoryBrief(ws, "improve login validation"));
    // Equal lexical score → root project precedence (root > subdir > global).
    expect(lines[0]).toBe("- [convention] login validation in root");
  });

  it("builds a brief from a subdir fact even when root + global are empty", () => {
    const ws = makeWorkspace(); // no root project.md, no global
    writeSubdirMemory(ws, "packages/api", "# API Memory\n- [convention] api uses fastify\n");
    const brief = buildMemoryBrief(ws, "anything at all");
    expect(brief).toBeDefined();
    expect(brief).toContain("api uses fastify");
  });
});
