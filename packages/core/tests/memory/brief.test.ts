import { describe, expect, it } from "vitest";
import { buildMemoryBrief, readProjectMemory } from "../../src/memory/index.js";
import { makeWorkspace, writeProjectMemory } from "./helpers.js";

const STALE_WARNING =
  "Remembered facts from earlier sessions — may be stale; verify before relying on them.";

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
    expect(bullets(brief)[0]).toBe(
      "- [path] src/login.ts contains the login form and its submit handler",
    );
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
    expect(lines[1]).toBe(
      "- [convention] validation of login forms happens in separate middleware modules",
    );
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
    expect(brief).not.toContain("unrelated docs");
  });

  it("relevance floor: a single weak unigram hit is dropped, yielding no brief", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        // Shares only "logic" with the task — noise, not relevance.
        "- [task_pattern] retry logic lives behind a feature flag",
        "- [convention] components use kebab-case filenames",
        "",
      ].join("\n"),
    );
    expect(buildMemoryBrief(ws, "refactor websocket reconnect logic")).toBeUndefined();
  });

  it("returns undefined for a fully unrelated task (silence beats noise)", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [path] login form lives in src/login.ts",
        "- [convention] login validation uses zod schemas",
        "",
      ].join("\n"),
    );
    expect(buildMemoryBrief(ws, "upgrade the docker base image")).toBeUndefined();
  });

  it("always includes [command] and [tech] facts even with zero overlap", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [command] verify with pnpm typecheck && pnpm test",
        "- [tech] monorepo managed by pnpm workspaces",
        "- [convention] components use kebab-case filenames",
        "",
      ].join("\n"),
    );
    const brief = buildMemoryBrief(ws, "完全不相关的任务");
    expect(brief).toBeDefined();
    expect(brief).toContain("- [command] verify with pnpm typecheck && pnpm test");
    expect(brief).toContain("- [tech] monorepo managed by pnpm workspaces");
    // Other types below the floor are excluded.
    expect(brief).not.toContain("kebab-case");
  });

  it("caps the brief at 8 bullets plus the warning line", () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 20 }, (_, i) => `- [command] command number ${i}`);
    writeProjectMemory(ws, `# Project Memory\n${lines.join("\n")}\n`);
    const brief = buildMemoryBrief(ws, "anything");
    expect(brief!.split("\n")).toHaveLength(9);
    expect(brief!.split("\n")[0]).toBe(STALE_WARNING);
  });

  it("caps the total brief (header included) at 800 characters", () => {
    const ws = makeWorkspace();
    const long = "x".repeat(400);
    const factLines = Array.from({ length: 10 }, (_, i) => `- [tech] ${i} ${long}`);
    writeProjectMemory(ws, `# Project Memory\n${factLines.join("\n")}\n`);
    const brief = buildMemoryBrief(ws, "anything");
    expect(brief!.length).toBeLessThanOrEqual(800);
    expect(bullets(brief).length).toBeGreaterThan(0);
  });

  it("returns undefined when no bullet fits under the size cap", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, `# Project Memory\n- [tech] ${"y".repeat(900)}\n`);
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
