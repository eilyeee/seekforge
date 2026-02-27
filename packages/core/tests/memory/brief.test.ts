import { describe, expect, it } from "vitest";
import { buildMemoryBrief, readProjectMemory } from "../../src/memory/index.js";
import { makeWorkspace, writeProjectMemory } from "./helpers.js";

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

  it("scores by keyword overlap and puts the most relevant bullet first", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [path] login form lives in src/login.ts",
        "- [convention] login validation uses zod login schemas",
        "- [path] unrelated config in conf/x.toml",
        "",
      ].join("\n"),
    );
    const brief = buildMemoryBrief(ws, "fix the login validation bug");
    expect(brief).toBeDefined();
    const lines = brief!.split("\n");
    // Two keywords (login, validation) beat one (login); unrelated dropped.
    expect(lines[0]).toBe("- [convention] login validation uses zod login schemas");
    expect(lines[1]).toBe("- [path] login form lives in src/login.ts");
    expect(brief).not.toContain("conf/x.toml");
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
    // Other types with zero score are excluded.
    expect(brief).not.toContain("kebab-case");
  });

  it("caps the brief at 12 bullets", () => {
    const ws = makeWorkspace();
    const bullets = Array.from({ length: 20 }, (_, i) => `- [command] command number ${i}`);
    writeProjectMemory(ws, `# Project Memory\n${bullets.join("\n")}\n`);
    const brief = buildMemoryBrief(ws, "anything");
    expect(brief!.split("\n")).toHaveLength(12);
  });

  it("caps the brief at 1500 characters", () => {
    const ws = makeWorkspace();
    const long = "x".repeat(400);
    const bullets = Array.from({ length: 10 }, (_, i) => `- [tech] ${i} ${long}`);
    writeProjectMemory(ws, `# Project Memory\n${bullets.join("\n")}\n`);
    const brief = buildMemoryBrief(ws, "anything");
    expect(brief!.length).toBeLessThanOrEqual(1500);
    expect(brief!.split("\n").length).toBeGreaterThan(0);
  });

  it("returns undefined when no bullet is relevant and none is always-include", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [path] something in src/a.ts\n");
    expect(buildMemoryBrief(ws, "zzz")).toBeUndefined();
  });
});
