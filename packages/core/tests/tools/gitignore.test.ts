import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceIgnore } from "../../src/tools/gitignore.js";
import { makeWorkspace } from "./helpers.js";

function workspaceWith(files: Record<string, string>): string {
  const ws = makeWorkspace();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
  return ws;
}

function ignored(ws: string, rel: string, isDir = false): boolean {
  return WorkspaceIgnore.forWorkspace(ws).isIgnored(rel, isDir);
}

describe("gitignore matching", () => {
  it("matches an unanchored name at any depth", () => {
    const ws = workspaceWith({ ".gitignore": "*.log\ntmp\n" });
    expect(ignored(ws, "a.log")).toBe(true);
    expect(ignored(ws, "deep/down/b.log")).toBe(true);
    expect(ignored(ws, "deep/tmp", true)).toBe(true);
    expect(ignored(ws, "deep/tmp.txt")).toBe(false);
    expect(ignored(ws, "a.log.txt")).toBe(false);
  });

  it("anchors a pattern with a leading or middle slash to its file's directory", () => {
    const ws = workspaceWith({ ".gitignore": "/root-only.txt\ndocs/generated\n" });
    expect(ignored(ws, "root-only.txt")).toBe(true);
    expect(ignored(ws, "sub/root-only.txt")).toBe(false);
    expect(ignored(ws, "docs/generated", true)).toBe(true);
    expect(ignored(ws, "other/docs/generated", true)).toBe(false);
  });

  it("applies a trailing-slash pattern to directories only", () => {
    const ws = workspaceWith({ ".gitignore": "out/\n" });
    expect(ignored(ws, "out", true)).toBe(true);
    expect(ignored(ws, "out", false)).toBe(false);
    // A file below an ignored directory is ignored with it.
    expect(ignored(ws, "out/bundle.js")).toBe(true);
  });

  it("lets a later negation re-include, and the last match wins", () => {
    const ws = workspaceWith({ ".gitignore": "*.env.*\n!keep.env.example\n" });
    expect(ignored(ws, "prod.env.local")).toBe(true);
    expect(ignored(ws, "keep.env.example")).toBe(false);
  });

  it("cannot re-include a file whose parent directory is ignored", () => {
    const ws = workspaceWith({ ".gitignore": "build/\n!build/keep.txt\n" });
    expect(ignored(ws, "build/keep.txt")).toBe(true);
  });

  it("supports the three positional forms of **", () => {
    const ws = workspaceWith({ ".gitignore": "**/cache\nlogs/**\na/**/z.txt\n" });
    expect(ignored(ws, "cache", true)).toBe(true);
    expect(ignored(ws, "x/y/cache", true)).toBe(true);
    expect(ignored(ws, "logs/today.txt")).toBe(true);
    expect(ignored(ws, "logs", true)).toBe(false);
    expect(ignored(ws, "a/z.txt")).toBe(true);
    expect(ignored(ws, "a/b/c/z.txt")).toBe(true);
    expect(ignored(ws, "b/a/z.txt")).toBe(false);
  });

  it("never lets * ? or a class cross a slash", () => {
    const ws = workspaceWith({ ".gitignore": "src/*.gen\nx?y\n[ab]/c\n" });
    expect(ignored(ws, "src/a.gen")).toBe(true);
    expect(ignored(ws, "src/deep/a.gen")).toBe(false);
    expect(ignored(ws, "x/y")).toBe(false);
    expect(ignored(ws, "xzy")).toBe(true);
    expect(ignored(ws, "a/c")).toBe(true);
  });

  it("honors comments, escapes, and trailing spaces", () => {
    const ws = workspaceWith({ ".gitignore": "# comment\n\\#hash\n\\!bang\ntrailing   \nspace\\ \n" });
    expect(ignored(ws, "# comment")).toBe(false);
    expect(ignored(ws, "#hash")).toBe(true);
    expect(ignored(ws, "!bang")).toBe(true);
    expect(ignored(ws, "trailing")).toBe(true);
    expect(ignored(ws, "space ")).toBe(true);
  });

  it("lets a nested .gitignore override its parent for its own subtree", () => {
    const ws = workspaceWith({ ".gitignore": "*.txt\n", "pkg/.gitignore": "!notes.txt\n/local-only\n" });
    expect(ignored(ws, "notes.txt")).toBe(true);
    expect(ignored(ws, "pkg/notes.txt")).toBe(false);
    expect(ignored(ws, "pkg/other.txt")).toBe(true);
    expect(ignored(ws, "pkg/local-only", true)).toBe(true);
    // Anchored to pkg/, not to the workspace root.
    expect(ignored(ws, "local-only", true)).toBe(false);
  });

  it("reads .git/info/exclude below the .gitignore files", () => {
    const ws = workspaceWith({ ".git/info/exclude": "secret-notes/\n", ".gitignore": "!secret-notes/\n" });
    expect(ignored(ws, "secret-notes", true)).toBe(false);
    const other = workspaceWith({ ".git/info/exclude": "scratch.md\n" });
    expect(ignored(other, "scratch.md")).toBe(true);
  });

  it("follows a worktree's .git file to the common info/exclude", () => {
    const main = workspaceWith({ ".git/info/exclude": "local.cfg\n", ".git/worktrees/wt/commondir": "../..\n" });
    const wt = makeWorkspace();
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    expect(ignored(wt, "local.cfg")).toBe(true);
  });

  it("applies the repository's ignores to a workspace opened at a subdirectory", () => {
    const repo = workspaceWith({ ".git/HEAD": "ref: refs/heads/main\n", ".gitignore": "*.tmp\n/pkg/gen/\n" });
    const pkg = path.join(repo, "pkg");
    fs.mkdirSync(path.join(pkg, "gen"), { recursive: true });
    expect(ignored(pkg, "a.tmp")).toBe(true);
    expect(ignored(pkg, "gen", true)).toBe(true);
    expect(ignored(pkg, "src", true)).toBe(false);
  });

  it("drops the repository's ignores when they cover the workspace itself", () => {
    const repo = workspaceWith({ ".git/HEAD": "ref: refs/heads/main\n", ".gitignore": "vendor/\n*.o\n" });
    const vendored = path.join(repo, "vendor", "lib");
    fs.mkdirSync(vendored, { recursive: true });
    expect(ignored(vendored, "main.c")).toBe(false);
    expect(ignored(vendored, "main.o")).toBe(false);
  });

  it("does not follow a symlinked .gitignore", () => {
    const outside = workspaceWith({ rules: "*\n" });
    const ws = makeWorkspace();
    fs.symlinkSync(path.join(outside, "rules"), path.join(ws, ".gitignore"));
    expect(ignored(ws, "anything.ts")).toBe(false);
  });

  it("picks up an edited .gitignore on the next matcher", () => {
    const ws = workspaceWith({ ".gitignore": "a.txt\n" });
    expect(ignored(ws, "b.txt")).toBe(false);
    fs.writeFileSync(path.join(ws, ".gitignore"), "a.txt\nb.txt\n");
    expect(ignored(ws, "b.txt")).toBe(true);
  });

  it("treats paths below an explicitly chosen directory relative to it", () => {
    const ws = workspaceWith({ ".gitignore": "generated/\n" });
    const matcher = WorkspaceIgnore.forWorkspace(ws);
    expect(matcher.isIgnored("generated/a.ts", false)).toBe(true);
    expect(matcher.isIgnored("generated/a.ts", false, "generated")).toBe(false);
  });
});
