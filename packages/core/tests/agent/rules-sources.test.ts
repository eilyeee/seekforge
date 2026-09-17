import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectProjectRules,
  collectRuleFiles,
  loadProjectRules,
  parseRuleFrontmatter,
} from "../../src/agent/rules.js";
import { expandLineImports } from "../../src/util/line-imports.js";

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seekforge-home-"));
  workspace = mkdtempSync(join(tmpdir(), "seekforge-rules-src-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe("Claude Code instruction files", () => {
  it("loads the project CLAUDE files after the AGENTS file of the same tier", () => {
    write(workspace, "AGENTS.md", "agents rules");
    write(workspace, "CLAUDE.md", "claude rules");
    write(workspace, ".claude/CLAUDE.md", "dot-claude rules");
    write(workspace, "AGENTS.local.md", "agents local");
    write(workspace, "CLAUDE.local.md", "claude local");
    expect(collectRuleFiles(workspace, home).map((f) => f.origin)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      "AGENTS.local.md",
      "CLAUDE.local.md",
    ]);
  });

  it("includes identical content once", () => {
    write(workspace, "AGENTS.md", "same rules\n");
    write(workspace, "CLAUDE.md", "same rules");
    expect(collectProjectRules(workspace, home)).toBe("<!-- from: AGENTS.md -->\nsame rules");
  });

  it("does not repeat AGENTS.md when CLAUDE.md imports it", () => {
    write(workspace, "AGENTS.md", "shared rules");
    write(workspace, "CLAUDE.md", "@AGENTS.md\nclaude-only rule");
    const merged = collectProjectRules(workspace, home)!;
    expect(merged.match(/shared rules/g)).toHaveLength(1);
    expect(merged).toContain("<!-- from: CLAUDE.md -->\nclaude-only rule");
  });

  it("skips a CLAUDE.md symlinked to AGENTS.md (the common migration setup)", () => {
    write(workspace, "AGENTS.md", "one copy");
    symlinkSync(join(workspace, "AGENTS.md"), join(workspace, "CLAUDE.md"));
    expect(collectProjectRules(workspace, home)).toBe("<!-- from: AGENTS.md -->\none copy");
  });

  it("reads ~/.claude/CLAUDE.md only with claudeCompat all", () => {
    write(home, ".claude/CLAUDE.md", "user claude rules");
    write(workspace, "CLAUDE.md", "project claude rules");
    expect(collectProjectRules(workspace, home)).not.toContain("user claude rules");
    const all = collectProjectRules(workspace, home, undefined, { claudeCompat: "all" })!;
    expect(all.indexOf("user claude rules")).toBeLessThan(all.indexOf("project claude rules"));
    expect(all).toContain("<!-- from: ~/.claude/CLAUDE.md -->");
  });

  it("reads no Claude files with claudeCompat off", () => {
    write(home, ".claude/CLAUDE.md", "user claude rules");
    write(workspace, "CLAUDE.md", "project claude rules");
    write(workspace, ".claude/rules/style.md", "claude rule dir");
    write(workspace, "AGENTS.md", "agents rules");
    expect(collectProjectRules(workspace, home, undefined, { claudeCompat: "off" })).toBe(
      "<!-- from: AGENTS.md -->\nagents rules",
    );
  });
});

describe("@path imports in rules files", () => {
  it("inlines a workspace file relative to the including file", () => {
    write(workspace, "AGENTS.md", "top\n@docs/style.md\nbottom");
    write(workspace, "docs/style.md", "use tabs\n@nested.md");
    write(workspace, "docs/nested.md", "nested rule");
    expect(collectProjectRules(workspace, home)).toBe("<!-- from: AGENTS.md -->\ntop\nuse tabs\nnested rule\nbottom");
  });

  it("never lets a repository file import from outside the workspace", () => {
    write(home, ".ssh/config", "HOST SECRET");
    write(home, "notes.md", "HOME NOTES");
    const outside = mkdtempSync(join(tmpdir(), "seekforge-rules-outside-"));
    write(outside, "evil.md", "OUTSIDE");
    symlinkSync(outside, join(workspace, "linked"));
    write(
      workspace,
      "AGENTS.md",
      ["@~/notes.md", "@~/.ssh/config", `@${join(outside, "evil.md")}`, "@../evil.md", "@linked/evil.md"].join("\n"),
    );
    const merged = collectProjectRules(workspace, home)!;
    for (const leaked of ["HOST SECRET", "HOME NOTES", "OUTSIDE"]) expect(merged).not.toContain(leaked);
    // Refused imports stay visible as the text they are.
    expect(merged).toContain("@~/notes.md");
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses to import a sensitive file", () => {
    write(workspace, ".env", "API_KEY=sk-live");
    write(workspace, ".seekforge/config.json", '{"apiKey":"sk-config"}');
    write(workspace, "AGENTS.md", "@.env\n@.seekforge/config.json");
    const merged = collectProjectRules(workspace, home)!;
    expect(merged).not.toContain("sk-live");
    expect(merged).not.toContain("sk-config");
  });

  it("lets a user file import from the home directory, including ~/", () => {
    write(home, ".seekforge/AGENTS.md", "@~/shared/rules.md\n@parts/tone.md");
    write(home, "shared/rules.md", "user shared rule");
    write(home, ".seekforge/parts/tone.md", "user tone rule");
    const merged = collectProjectRules(workspace, home)!;
    expect(merged).toContain("user shared rule");
    expect(merged).toContain("user tone rule");
  });

  it("leaves @ lines inside code fences and unresolved @ lines alone", () => {
    write(workspace, "decorated.md", "SHOULD NOT INLINE");
    write(workspace, "AGENTS.md", "```ts\n@decorated.md\n```\n@types/node is a dev dependency");
    const merged = collectProjectRules(workspace, home)!;
    expect(merged).toContain("```ts\n@decorated.md\n```");
    expect(merged).not.toContain("SHOULD NOT INLINE");
    expect(merged).toContain("@types/node is a dev dependency");
  });

  it("breaks cycles and stops at the depth limit", () => {
    write(workspace, "AGENTS.md", "@a.md");
    write(workspace, "a.md", "A\n@b.md");
    write(workspace, "b.md", "B\n@a.md");
    expect(collectProjectRules(workspace, home)).toBe("<!-- from: AGENTS.md -->\nA\nB");

    write(workspace, "AGENTS.md", "@d1.md");
    for (let i = 1; i <= 7; i++) write(workspace, `d${i}.md`, `level ${i}\n@d${i + 1}.md`);
    const deep = collectProjectRules(workspace, home)!;
    expect(deep).toContain("level 5");
    expect(deep).not.toContain("level 6");
  });

  it("skips a file whose imports push it past the size limit", () => {
    write(workspace, "big.md", "x".repeat(200 * 1024));
    write(workspace, "AGENTS.md", "@big.md\n@big2.md");
    write(workspace, "big2.md", "y".repeat(100 * 1024));
    write(workspace, "AGENTS.local.md", "@big.md\nlocal");
    const files = collectRuleFiles(workspace, home);
    // AGENTS.md was skipped whole, so the local file still gets big.md.
    expect(files.map((f) => f.origin)).toEqual(["AGENTS.local.md"]);
    expect(files[0]!.content).toContain("x".repeat(100));
  });
});

describe("line-import expansion (shared with memory files)", () => {
  it("drops unresolved lines unless asked to keep them", () => {
    const opts = {
      resolve: (spec: string) => (spec === "ok" ? "ok" : undefined),
      read: (rel: string) => (rel === "ok" ? "OK" : undefined),
      maxDepth: 3,
      visited: new Set<string>(),
    };
    expect(expandLineImports("a\n@ok\n@nope", "root", { ...opts, budget: { remaining: 100 } })).toBe("a\nOK");
    expect(
      expandLineImports("a\n@nope", "root", {
        ...opts,
        visited: new Set(),
        budget: { remaining: 100 },
        keepUnresolved: true,
      }),
    ).toBe("a\n@nope");
  });
});

describe("rules directories", () => {
  it("loads rules without paths into the prompt, sorted, .seekforge before .claude", () => {
    write(workspace, ".seekforge/rules/b.md", "seekforge b");
    write(workspace, ".seekforge/rules/a/nested.md", "seekforge nested");
    write(workspace, ".claude/rules/c.md", "---\ndescription: x\n---\nclaude c");
    write(workspace, ".seekforge/rules/notes.txt", "not markdown");
    const rules = loadProjectRules(workspace, { home });
    expect(rules.included).toEqual([".seekforge/rules/a/nested.md", ".seekforge/rules/b.md", ".claude/rules/c.md"]);
    expect(rules.text).toContain("<!-- from: .claude/rules/c.md -->\nclaude c");
    expect(rules.text).not.toContain("description:");
    expect(rules.scoped).toEqual([]);
  });

  it("holds rules with paths back for later", () => {
    write(workspace, ".seekforge/rules/api.md", '---\npaths:\n  - "src/api/**/*.ts"\n---\nAPI RULE');
    const rules = loadProjectRules(workspace, { home });
    expect(rules.text).toBeUndefined();
    expect(rules.scoped.map((r) => [r.origin, r.paths, r.text])).toEqual([
      [".seekforge/rules/api.md", ["src/api/**/*.ts"], "API RULE"],
    ]);
  });

  it("does not follow a symlinked rules directory out of the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "seekforge-rules-dir-"));
    write(outside, "evil.md", "OUTSIDE RULE");
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    symlinkSync(outside, join(workspace, ".seekforge", "rules"));
    expect(loadProjectRules(workspace, { home }).text ?? "").not.toContain("OUTSIDE RULE");
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("rule frontmatter", () => {
  it.each([
    ["---\npaths:\n  - src/**/*.ts\n  - 'docs/*.md'\n---\nbody", ["src/**/*.ts", "docs/*.md"]],
    ['---\npaths: ["src/**/*.{ts,tsx}", lib/*.js]\n---\nbody', ["src/**/*.{ts,tsx}", "lib/*.js"]],
    ["---\npaths: src/**/*.{ts,tsx}, test/** # comment\n---\nbody", ["src/**/*.{ts,tsx}", "test/**"]],
    ['---\ntitle: x\npaths:\n\n  # a comment\n  - "a\\"b"\nother: y\n---\nbody', ['a"b']],
    ["---\ndescription: none\n---\nbody", []],
    ["no frontmatter", []],
  ])("parses %j", (markdown, paths) => {
    const parsed = parseRuleFrontmatter(markdown);
    expect(parsed.paths).toEqual(paths);
    expect(parsed.body.trim()).toBe(markdown.includes("---") ? "body" : markdown);
  });
});
