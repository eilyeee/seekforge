import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiKeyHelperError,
  apiKeyHelperFor,
  apiKeyHelperTtlMs,
  clearApiKeyHelperCache,
  DEFAULT_API_KEY_HELPER_TTL_MS,
  getApiKeyFromHelper,
  invalidateApiKeyHelper,
  refreshApiKeyHelper,
  resolveApiKeyHelperSync,
} from "../src/api-key-helper.js";

let dir: string;

/**
 * A helper command that prints `key-<n>` where n counts its own runs, so a
 * test can tell a cached answer from a fresh one. `extra` is appended to what
 * it prints (to test multi-token output); `exit` is its exit code.
 */
function counterHelper(opts: { extra?: string; exit?: number; sleepMs?: number; prefix?: string } = {}): {
  command: string;
  runs: () => number;
} {
  const counter = join(dir, `runs-${Math.random().toString(36).slice(2)}`);
  writeFileSync(counter, "0");
  const script = join(dir, `helper-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(
    script,
    `const fs = require("node:fs");
const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
setTimeout(() => {
  process.stdout.write("  ${opts.prefix ?? "key"}-" + n + ${JSON.stringify(opts.extra ?? "")} + "\\n");
  process.stderr.write("stderr noise sk-from-stderr\\n");
  process.exitCode = ${opts.exit ?? 0};
}, ${opts.sleepMs ?? 0});
`,
  );
  return {
    command: `"${process.execPath}" "${script}"`,
    runs: () => Number(readFileSync(counter, "utf8")),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-key-helper-"));
  clearApiKeyHelperCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearApiKeyHelperCache();
  rmSync(dir, { recursive: true, force: true });
});

// Every case starts real processes, which is seconds each on a loaded machine.
describe("apiKeyHelper", { timeout: 30_000 }, () => {
  it("returns the trimmed key, caches it, and remembers which helper issued it", () => {
    const helper = counterHelper();
    expect(resolveApiKeyHelperSync(helper.command)).toBe("key-1");
    expect(resolveApiKeyHelperSync(helper.command)).toBe("key-1");
    expect(helper.runs()).toBe(1);
    expect(apiKeyHelperFor("key-1")).toBe(helper.command);
    expect(apiKeyHelperFor("key-2")).toBeUndefined();
    expect(apiKeyHelperFor(undefined)).toBeUndefined();
  });

  it("never puts what the command printed into an error", () => {
    const failing = counterHelper({ exit: 3, prefix: "sk-secret" });
    let message = "";
    try {
      resolveApiKeyHelperSync(failing.command);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiKeyHelperError);
      message = (error as Error).message;
    }
    expect(message).toContain("exited with code 3");
    expect(message).not.toContain("sk-secret");
    expect(message).not.toContain("sk-from-stderr");

    const twoTokens = counterHelper({ extra: " sk-other" });
    expect(() => resolveApiKeyHelperSync(twoTokens.command)).toThrow(/more than one token/);
    expect(() => resolveApiKeyHelperSync(twoTokens.command)).not.toThrow(/sk-other/);
  });

  it("rejects a command that prints nothing, cannot start, or runs too long", async () => {
    expect(() => resolveApiKeyHelperSync(`"${process.execPath}" -e ""`)).toThrow(/printed nothing/);
    expect(() => resolveApiKeyHelperSync("exit 127")).toThrow(/exited with code 127/);
    const slow = counterHelper({ sleepMs: 5_000 });
    expect(() => resolveApiKeyHelperSync(slow.command, { timeoutMs: 200 })).toThrow(/timed out after 200ms/);
    await expect(getApiKeyFromHelper(slow.command, undefined, { timeoutMs: 200 })).rejects.toThrow(
      /timed out after 200ms/,
    );
  });

  it("replays a recent synchronous failure instead of blocking on the command again", async () => {
    const failing = counterHelper({ exit: 4 });
    expect(() => resolveApiKeyHelperSync(failing.command)).toThrow(/exited with code 4/);
    expect(() => resolveApiKeyHelperSync(failing.command)).toThrow(/exited with code 4/);
    expect(failing.runs()).toBe(1);
    // The provider's own awaited path still tries the command.
    await expect(getApiKeyFromHelper(failing.command)).rejects.toThrow(/exited with code 4/);
    expect(failing.runs()).toBe(2);

    // Once any run succeeds, the replay is over.
    const mode = join(dir, "recovering-mode");
    const script = join(dir, "recovering.cjs");
    writeFileSync(mode, "down");
    writeFileSync(
      script,
      `if (require("node:fs").readFileSync(${JSON.stringify(mode)}, "utf8") !== "up") process.exit(1);
console.log("back-key");`,
    );
    const recovering = `"${process.execPath}" "${script}"`;
    expect(() => resolveApiKeyHelperSync(recovering)).toThrow(/exited with code 1/);
    writeFileSync(mode, "up");
    expect(() => resolveApiKeyHelperSync(recovering)).toThrow(/exited with code 1/);
    expect(await getApiKeyFromHelper(recovering)).toBe("back-key");
    expect(resolveApiKeyHelperSync(recovering)).toBe("back-key");
  });

  it("reads the TTL from SEEKFORGE_API_KEY_HELPER_TTL_MS", () => {
    expect(apiKeyHelperTtlMs({})).toBe(DEFAULT_API_KEY_HELPER_TTL_MS);
    expect(apiKeyHelperTtlMs({ SEEKFORGE_API_KEY_HELPER_TTL_MS: "0" })).toBe(0);
    expect(apiKeyHelperTtlMs({ SEEKFORGE_API_KEY_HELPER_TTL_MS: " 1500 " })).toBe(1500);
    expect(apiKeyHelperTtlMs({ SEEKFORGE_API_KEY_HELPER_TTL_MS: "-1" })).toBe(DEFAULT_API_KEY_HELPER_TTL_MS);
    expect(apiKeyHelperTtlMs({ SEEKFORGE_API_KEY_HELPER_TTL_MS: "soon" })).toBe(DEFAULT_API_KEY_HELPER_TTL_MS);
  });

  it("runs again once the key is older than the TTL", async () => {
    vi.stubEnv("SEEKFORGE_API_KEY_HELPER_TTL_MS", "0");
    const helper = counterHelper();
    expect(await getApiKeyFromHelper(helper.command)).toBe("key-1");
    expect(await getApiKeyFromHelper(helper.command)).toBe("key-2");
    expect(apiKeyHelperFor("key-1")).toBe(helper.command);
  });

  it("hands back a stale key at once from the sync path while it refreshes behind", async () => {
    const helper = counterHelper();
    expect(resolveApiKeyHelperSync(helper.command)).toBe("key-1");
    vi.stubEnv("SEEKFORGE_API_KEY_HELPER_TTL_MS", "0");
    expect(resolveApiKeyHelperSync(helper.command)).toBe("key-1");
    // A process start can take seconds on a loaded machine.
    const slowly = { timeout: 15_000, interval: 50 };
    await vi.waitFor(() => expect(helper.runs()).toBe(2), slowly);
    vi.stubEnv("SEEKFORGE_API_KEY_HELPER_TTL_MS", "60000");
    await vi.waitFor(() => expect(resolveApiKeyHelperSync(helper.command)).toBe("key-2"), slowly);
  });

  it("shares one run between concurrent callers", async () => {
    const helper = counterHelper({ sleepMs: 100 });
    const keys = await Promise.all([
      getApiKeyFromHelper(helper.command),
      getApiKeyFromHelper(helper.command),
      refreshApiKeyHelper(helper.command),
    ]);
    expect(keys).toEqual(["key-1", "key-1", "key-1"]);
    expect(helper.runs()).toBe(1);
  });

  it("lets a caller stop waiting without cancelling the run another caller shares", async () => {
    const helper = counterHelper({ sleepMs: 150 });
    const controller = new AbortController();
    const abandoned = getApiKeyFromHelper(helper.command, controller.signal);
    const patient = getApiKeyFromHelper(helper.command);
    controller.abort(new Error("user cancelled"));
    await expect(abandoned).rejects.toThrow("user cancelled");
    await expect(patient).resolves.toBe("key-1");
  });

  it("falls back to the replaced key when a refresh fails, but not after that key was rejected", async () => {
    const script = join(dir, "flaky.cjs");
    const mode = join(dir, "mode");
    writeFileSync(mode, "ok");
    writeFileSync(
      script,
      `const fs = require("node:fs");
if (fs.readFileSync(${JSON.stringify(mode)}, "utf8") !== "ok") process.exit(1);
console.log("stable-key");`,
    );
    const command = `"${process.execPath}" "${script}"`;
    expect(resolveApiKeyHelperSync(command)).toBe("stable-key");
    writeFileSync(mode, "broken");
    vi.stubEnv("SEEKFORGE_API_KEY_HELPER_TTL_MS", "0");
    expect(await getApiKeyFromHelper(command)).toBe("stable-key");

    invalidateApiKeyHelper(command, "some-other-key");
    expect(await getApiKeyFromHelper(command)).toBe("stable-key");
    invalidateApiKeyHelper(command, "stable-key");
    await expect(getApiKeyFromHelper(command)).rejects.toThrow(/exited with code 1/);
  });
});
