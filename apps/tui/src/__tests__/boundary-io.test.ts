import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CONFIG_FILE_BYTES, MAX_EDITOR_FILE_BYTES, MAX_STATE_FILE_BYTES } from "../bounded-file.js";
import { saveClipboardImage } from "../clipboard-image.js";
import { configParseErrors, loadConfig } from "../config.js";
import { loadCustomCommands } from "../custom-commands.js";
import { openInExternalEditor } from "../external-editor.js";
import { loadKeybindings } from "../keybindings.js";
import { readStateFile, writeStateFile } from "../state-file.js";

const roots: string[] = [];
const originalEditor = process.env.EDITOR;
const originalVisual = process.env.VISUAL;

afterEach(() => {
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  if (originalVisual === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = originalVisual;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function setEditor(root: string, source: string): void {
  const script = join(root, "editor.cjs");
  writeFileSync(script, source);
  process.env.EDITOR = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  delete process.env.VISUAL;
}

describe("bounded user/project files", () => {
  it("ignores and diagnoses an oversized project config", () => {
    const root = tempRoot("seekforge-tui-config-boundary-");
    const dir = join(root, ".seekforge");
    mkdirSync(dir);
    const file = join(dir, "config.json");
    writeFileSync(file, "{}");
    truncateSync(file, MAX_CONFIG_FILE_BYTES + 1);

    expect(loadConfig(root).model).toBeUndefined();
    expect(configParseErrors(root)).toContain(file);
  });

  it("skips oversized custom commands and keybindings", () => {
    const root = tempRoot("seekforge-tui-user-files-");
    const home = tempRoot("seekforge-tui-user-home-");
    const commands = join(root, ".seekforge", "commands");
    mkdirSync(commands, { recursive: true });
    const command = join(commands, "large.md");
    writeFileSync(command, "x");
    truncateSync(command, MAX_CONFIG_FILE_BYTES + 1);
    const state = join(root, ".seekforge");
    const keybindings = join(state, "keybindings.json");
    writeFileSync(keybindings, "{}");
    truncateSync(keybindings, MAX_CONFIG_FILE_BYTES + 1);

    expect(loadCustomCommands(root, home)).toEqual([]);
    expect(loadKeybindings(root, home)).toEqual([]);
  });
});

describe("state persistence", () => {
  it("atomically replaces state with a private regular file", () => {
    const root = tempRoot("seekforge-tui-state-");
    const file = join(root, ".seekforge", "history.jsonl");
    writeStateFile(file, "old\n");
    const firstInode = lstatSync(file).ino;
    writeStateFile(file, "new\n");

    expect(readStateFile(file)).toBe("new\n");
    expect(lstatSync(file).ino).not.toBe(firstInode);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects an oversized update without changing prior state", () => {
    const root = tempRoot("seekforge-tui-state-large-");
    const file = join(root, ".seekforge", "stash.json");
    writeStateFile(file, "preserve");
    expect(() => writeStateFile(file, "x".repeat(MAX_STATE_FILE_BYTES + 1))).toThrow(/state exceeds/);
    expect(readFileSync(file, "utf8")).toBe("preserve");
  });
});

describe("external editor isolation", () => {
  it("uses a 0600 file in a private random directory and removes it", () => {
    const root = tempRoot("seekforge-editor-root-");
    const report = join(root, "mode.txt");
    setEditor(
      root,
      `const fs=require("node:fs");const f=process.argv[2];fs.writeFileSync(${JSON.stringify(
        report,
      )},String(fs.statSync(f).mode&0o777));fs.writeFileSync(f,"edited");`,
    );

    expect(openInExternalEditor("secret", root)).toEqual({ ok: true, text: "edited" });
    expect(readFileSync(report, "utf8")).toBe(String(0o600));
    expect(requireDirectoryEntries(root)).toEqual(["editor.cjs", "mode.txt"]);
  });

  it("rejects symlink and oversized editor results", () => {
    const root = tempRoot("seekforge-editor-attacks-");
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "outside secret");
    setEditor(
      root,
      `const fs=require("node:fs");const f=process.argv[2];fs.unlinkSync(f);fs.symlinkSync(${JSON.stringify(secret)},f);`,
    );
    expect(openInExternalEditor("draft", root)).toMatchObject({ ok: false });

    setEditor(root, `require("node:fs").truncateSync(process.argv[2],${MAX_EDITOR_FILE_BYTES + 1});`);
    expect(openInExternalEditor("draft", root)).toMatchObject({ ok: false });
  });
});

describe("clipboard image persistence", () => {
  const name = "img-20260721-120000-0123456789abcdef0123456789abcdef.png";

  it("rejects symlinked upload parents without writing outside", () => {
    const root = tempRoot("seekforge-clipboard-ws-");
    const outside = tempRoot("seekforge-clipboard-outside-");
    mkdirSync(join(root, ".seekforge"));
    symlinkSync(outside, join(root, ".seekforge", "uploads"));

    expect(saveClipboardImage(root, Buffer.from("png"), name)).toBeNull();
    expect(requireDirectoryEntries(outside)).toEqual([]);
  });

  it("never follows or replaces an existing leaf", () => {
    const root = tempRoot("seekforge-clipboard-leaf-");
    const outside = tempRoot("seekforge-clipboard-leaf-outside-");
    const state = join(root, ".seekforge");
    const uploads = join(state, "uploads");
    mkdirSync(uploads, { recursive: true });
    const target = join(outside, "target.png");
    writeFileSync(target, "keep");
    symlinkSync(target, join(uploads, name));

    expect(saveClipboardImage(root, Buffer.from("replace"), name)).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("creates an exclusive private image file", () => {
    const root = tempRoot("seekforge-clipboard-save-");
    expect(saveClipboardImage(root, Buffer.from("png"), name)).toEqual({ path: `.seekforge/uploads/${name}` });
    const file = join(root, ".seekforge", "uploads", name);
    expect(readFileSync(file, "utf8")).toBe("png");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(saveClipboardImage(root, Buffer.from("new"), name)).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("png");
  });
});

function requireDirectoryEntries(path: string): string[] {
  return readdirSync(path).sort();
}
