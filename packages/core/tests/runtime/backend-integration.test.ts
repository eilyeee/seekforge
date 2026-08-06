import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSensitiveBasename, isSensitiveRelPath, type PermissionPolicy } from "@seekforge/shared";
import { createDefaultDispatcher, type ToolContext } from "../../src/tools/index.js";
import { createRuntimeClient, type RuntimeClient } from "../../src/runtime/client.js";

/**
 * Full-stack check: TS dispatcher (permissions, validation, post-processing)
 * delegating execution to the real Rust seekforge-runtime binary.
 * Skipped when the binary has not been built (cargo build --release).
 */
const BIN = process.env["SEEKFORGE_RUNTIME_BIN"] ?? resolve(__dirname, "../../../../target/release/seekforge-runtime");

const hasBinary = existsSync(BIN);

// CI sets SEEKFORGE_REQUIRE_RUNTIME_TESTS=1 after building the runtime, so a
// missing binary becomes a hard failure instead of a silent skip (the same
// sentinel pattern os-sandbox.test.ts uses). Without it, local runs still skip.
if (process.env["SEEKFORGE_REQUIRE_RUNTIME_TESTS"] === "1" && !hasBinary) {
  describe("rust runtime backend (integration)", () => {
    it("requires the seekforge-runtime binary to be built", () => {
      throw new Error(
        `seekforge-runtime not found at ${BIN}. Build it with \`cargo build --release -p seekforge-runtime\` ` +
          "or unset SEEKFORGE_REQUIRE_RUNTIME_TESTS.",
      );
    });
  });
}

describe.skipIf(!hasBinary)("rust runtime backend (integration)", () => {
  let workspace: string;
  let runtime: RuntimeClient;

  const policy: PermissionPolicy = { approvalMode: "auto", mode: "edit", commandAllowlist: [] };
  const ctx = (signal?: AbortSignal): ToolContext => ({
    sessionId: "it",
    workspace,
    policy,
    confirm: async () => true,
    runtime,
    signal,
  });

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-rust-it-"));
    runtime = createRuntimeClient({ binPath: BIN });
  });

  afterAll(() => {
    runtime?.dispose();
    rmSync(workspace, { recursive: true, force: true });
  });

  const dispatcher = createDefaultDispatcher();
  const exec = (name: string, args: unknown) => dispatcher.execute({ id: "t", name, arguments: args }, ctx());

  it("write_file → read_file round trip through the runtime", async () => {
    const w = await exec("write_file", { path: "src/a.txt", content: "hello runtime\n" });
    expect(w.ok).toBe(true);
    const r = await exec("read_file", { path: "src/a.txt" });
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toContain("hello runtime");
  });

  it("apply_patch edits atomically and reports no_match", async () => {
    writeFileSync(join(workspace, "edit-me.txt"), "alpha\nbeta\ngamma\n");
    const ok = await exec("apply_patch", {
      path: "edit-me.txt",
      edits: [{ oldString: "beta", newString: "BETA" }],
    });
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(workspace, "edit-me.txt"), "utf8")).toContain("BETA");

    const miss = await exec("apply_patch", {
      path: "edit-me.txt",
      edits: [{ oldString: "does-not-exist", newString: "x" }],
    });
    expect(miss.ok).toBe(false);
    expect(miss.error?.code).toBe("no_match");
  });

  it("run_command executes via the runtime and respects the denylist", async () => {
    const echo = await exec("run_command", { command: "echo from-rust" });
    expect(echo.ok).toBe(true);
    expect((echo.data as { stdout: string }).stdout).toContain("from-rust");

    const denied = await exec("run_command", { command: "sudo rm -rf /" });
    expect(denied.ok).toBe(false);
    // The TS permission layer refuses dangerous commands before the runtime
    // is even consulted (defense in depth: the runtime would also deny it).
    expect(denied.error?.code).toMatch(/denied_dangerous|forbidden/);
  });

  it("cancels a runtime command from the tool context signal", async () => {
    const controller = new AbortController();
    const running = dispatcher.execute(
      { id: "cancel", name: "run_command", arguments: { command: "sleep 10" } },
      ctx(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);

    await expect(running).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  it("denies workspace escapes from the runtime side too", async () => {
    const r = await exec("read_file", { path: "../../etc/hosts" });
    expect(r.ok).toBe(false);
  });

  it("list_files honors the ignore list", async () => {
    writeFileSync(join(workspace, "visible.txt"), "x");
    const r = await exec("list_files", {});
    expect(r.ok).toBe(true);
    const entries = (r.data as { entries: string[] }).entries;
    expect(entries).toContain("visible.txt");
  });

  /**
   * The sensitive-file list exists TWICE — as regexes in @seekforge/shared and
   * as string comparisons in crates/runtime/src/sandbox.rs, whose own header
   * calls itself a second line of defense that "mirrors the TypeScript
   * sandbox". Two hand-maintained copies of a security rule in two languages
   * drift; this session already found one such divergence in list_files, where
   * the two backends of one tool answered differently about truncation.
   *
   * So this asks the RUNTIME directly — not through the dispatcher, which
   * would refuse in TypeScript before Rust ever saw the path — and requires it
   * to agree with the TS predicate file by file.
   */
  it("refuses exactly the files the TypeScript sandbox calls sensitive", async () => {
    const names = [
      ".env",
      ".env.local",
      "server.pem",
      "private.key",
      "id_rsa",
      "id_ed25519",
      ".npmrc",
      ".netrc",
      ".pgpass",
      ".git-credentials",
      // Not sensitive: the guard must not be a blanket refusal of dotfiles or
      // of anything that merely looks credential-adjacent.
      "README.md",
      ".gitignore",
      "env.example",
      "keyboard.ts",
      "id_rsa_notes.md.txt",
    ];
    for (const name of names) writeFileSync(join(workspace, name), "x");

    for (const name of names) {
      const expected = isSensitiveBasename(name);
      const result = await runtime
        .call<{ content: string }>("read_file", { workspace, path: name })
        .then(() => "read" as const)
        .catch(() => "refused" as const);
      expect(result, `${name} (TS says sensitive=${expected})`).toBe(expected ? "refused" : "read");
    }
  });

  it("refuses the sensitive workspace-relative paths too", async () => {
    // Generic basenames whose CONTENTS are secrets — SeekForge's own config
    // holds the provider key. Basename matching cannot catch these, so both
    // implementations carry the same short list of relative paths.
    for (const rel of [".seekforge/config.json", ".seekforge/triggers.json", ".git/config"]) {
      mkdirSync(join(workspace, dirname(rel)), { recursive: true });
      writeFileSync(join(workspace, rel), "secret");
      expect(isSensitiveRelPath(rel)).toBe(true);
      await expect(runtime.call("read_file", { workspace, path: rel })).rejects.toThrow();
    }
  });

  it("marks a truncated listing in the list itself, as the local walk does", async () => {
    // Both backends answer the same tool, so they have to answer it the same
    // way. The runtime caps at 500 entries and reported `truncated: true` in a
    // field beside the list — while the list itself looked like a complete
    // directory of exactly 500 files.
    for (let i = 0; i < 520; i++) writeFileSync(join(workspace, `f${i}.txt`), "x");
    const r = await exec("list_files", {});
    expect(r.ok).toBe(true);
    const data = r.data as { entries: string[]; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(data.entries[data.entries.length - 1]).toMatch(/^\.\.\. \[truncated at \d+ entries\]$/);
  });
});

if (!hasBinary) {
  describe("rust runtime backend (integration)", () => {
    it.skip(`skipped — build the binary first: cargo build --release (looked at ${BIN})`, () => {});
  });
}
