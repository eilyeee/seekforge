import { describe, expect, it } from "vitest";
import {
  compileHookMatcher,
  HOOK_STAGES,
  hookEntryLabel,
  parseHookEntry,
  parseHooksConfig,
  sanitizeHookEntries,
} from "../src/index.js";
import { mergeConfigLayers, repositoryConfigLayer, userConfigLayer } from "../src/config-layers.js";

const matches = (match: string | undefined, subject: string): boolean => {
  const compiled = compileHookMatcher(match);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.value(subject);
};

describe("compileHookMatcher", () => {
  it("treats *, blank and absent as match-all", () => {
    for (const match of [undefined, "", "  ", "*"]) expect(matches(match, "anything")).toBe(true);
  });

  it("reads plain names as an exact list separated by | or ,", () => {
    expect(matches("read_file", "read_file")).toBe(true);
    expect(matches("read_file", "read_file2")).toBe(false);
    expect(matches("write_file|apply_patch", "apply_patch")).toBe(true);
    expect(matches("write_file, apply_patch", "write_file")).toBe(true);
    expect(matches("write_file|apply_patch", "read_file")).toBe(false);
    expect(compileHookMatcher("|").ok).toBe(false);
  });

  it("anchors a regex to the whole name", () => {
    expect(matches("mcp__github__.*", "mcp__github__create_issue")).toBe(true);
    expect(matches("mcp__github__.*", "xmcp__github__create_issue")).toBe(false);
    expect(matches("apply.*", "apply_patch")).toBe(true);
    expect(matches(".*patch", "apply_patch_v2")).toBe(false);
    expect(matches("(write|read)_file", "read_file")).toBe(true);
  });

  it.each([
    ["(a+)+", "repeated group"],
    ["(a|aa)*", "repeated group"],
    ["((ab)*)+", "repeated group"],
    ["(\\w+\\s?)*", "repeated group"],
    ["(a)\\1", "backreferences"],
    ["(?<x>a)\\k<x>", "backreferences"],
    [".*a.*b.*c.*d.*e", "at most 4"],
    ["(unclosed", "not a valid regular expression"],
    ["x".repeat(300), "longer than"],
  ])("refuses %s", (match, reason) => {
    const compiled = compileHookMatcher(match);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.error).toContain(reason);
  });

  it("accepts bounded quantifiers and quantified plain groups", () => {
    expect(matches("(ab){1,3}c", "ababc")).toBe(true);
    expect(matches("[a-z_]+", "read_file")).toBe(true);
    expect(matches("(?:mcp__)?read_file", "mcp__read_file")).toBe(true);
  });
});

describe("parseHookEntry", () => {
  it("defaults to a command hook and normalizes blank optionals away", () => {
    expect(parseHookEntry({ command: "  ./gate.sh ", match: "", pattern: " " })).toEqual({
      ok: true,
      value: { command: "./gate.sh" },
    });
    expect(parseHookEntry({ command: "" })).toMatchObject({ ok: false });
    expect(parseHookEntry({ match: "read_file" })).toMatchObject({ ok: false });
  });

  it("keeps only the fields of the entry's own type", () => {
    const parsed = parseHookEntry({
      type: "http",
      url: "https://hooks.example.test/pre",
      headers: { Authorization: "Bearer ${HOOK_TOKEN}" },
      allowedEnvVars: ["HOOK_TOKEN"],
      command: "ignored",
      prompt: "ignored",
      timeout: 5,
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        type: "http",
        url: "https://hooks.example.test/pre",
        headers: { Authorization: "Bearer ${HOOK_TOKEN}" },
        allowedEnvVars: ["HOOK_TOKEN"],
        timeout: 5,
      },
    });
  });

  it.each([
    [{ type: "http" }, "needs a url"],
    [{ type: "http", url: "ftp://example.test/x" }, "http or https"],
    [{ type: "http", url: "not a url" }, "not a valid URL"],
    [{ type: "http", url: "https://user:pw@example.test/" }, "credentials"],
    [{ type: "http", url: "https://example.test/", headers: { "X-A": "a\r\nX-B: b" } }, "single-line"],
    [{ type: "http", url: "https://example.test/", headers: { "bad name": "x" } }, "invalid header name"],
    [{ type: "http", url: "https://example.test/", allowedEnvVars: ["NOT-A-NAME"] }, "allowedEnvVars"],
    [{ type: "prompt" }, "non-empty prompt"],
    [{ type: "prompt", prompt: "x".repeat(20_001) }, "longer than"],
    [{ type: "agent", prompt: "x" }, "unknown hook type"],
    [{ command: "x", timeout: 0 }, "positive"],
    [{ command: "x", timeout: -1 }, "positive"],
    [{ command: "x", timeout: Number.NaN }, "positive"],
    [{ command: "x", timeout: 601 }, "600"],
    [{ command: "x", timeout: "5" }, "positive"],
    [{ command: "x", match: "(a+)+" }, "refused"],
    ["echo", "must be an object"],
  ])("rejects %j", (value, reason) => {
    const parsed = parseHookEntry(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(reason);
  });

  it("accepts the timeout bound and a prompt hook with a model", () => {
    expect(parseHookEntry({ command: "x", timeout: 600 })).toMatchObject({ ok: true });
    expect(parseHookEntry({ type: "prompt", prompt: "Is $ARGUMENTS safe?", model: "fast" })).toEqual({
      ok: true,
      value: { type: "prompt", prompt: "Is $ARGUMENTS safe?", model: "fast" },
    });
  });
});

describe("parseHooksConfig / sanitizeHookEntries", () => {
  it("names the stage and index of the first invalid entry", () => {
    expect(parseHooksConfig({ preToolUse: [{ command: "a" }, { type: "http" }] })).toEqual({
      ok: false,
      error: "preToolUse[1]: an http hook needs a url",
    });
    expect(parseHooksConfig({ beforeEverything: [] })).toMatchObject({ ok: false });
    expect(parseHooksConfig({ stop: "x" })).toMatchObject({ ok: false });
  });

  it("accepts every stage and drops empty ones", () => {
    const input = Object.fromEntries(HOOK_STAGES.map((stage) => [stage, [{ command: stage }]]));
    const parsed = parseHooksConfig({ ...input, sessionEnd: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.value)).toHaveLength(HOOK_STAGES.length - 1);
      expect(parsed.value.postCompact).toEqual([{ command: "postCompact" }]);
    }
  });

  it("filters invalid entries leniently", () => {
    expect(sanitizeHookEntries([{ command: "ok" }, { type: "http" }, 42])).toEqual([{ command: "ok" }]);
    expect(sanitizeHookEntries("nope")).toEqual([]);
  });
});

describe("hookEntryLabel", () => {
  it("never shows an http url's query string", () => {
    expect(hookEntryLabel({ type: "http", url: "https://h.example.test/p?token=secret" })).toBe(
      "POST https://h.example.test/p",
    );
    expect(hookEntryLabel({ command: "./gate.sh" })).toBe("./gate.sh");
    expect(hookEntryLabel({ type: "prompt", prompt: "Is this\n safe?" })).toBe("prompt: Is this safe?");
  });
});

describe("mergeConfigLayers hooks", () => {
  it("merges stages a surface's order list omits, after the listed ones", () => {
    const merged = mergeConfigLayers(
      [
        userConfigLayer({
          hooks: {
            postCompact: [{ command: "after" }],
            preToolUse: [{ type: "http", url: "http://127.0.0.1:9/pre" }],
          },
        }),
      ],
      { hookStages: ["preToolUse", "sessionEnd"], envOverrides: false },
    );
    expect(Object.keys(merged.hooks ?? {})).toEqual(["preToolUse", "postCompact"]);
    expect(merged.hooks?.preToolUse).toEqual([{ type: "http", url: "http://127.0.0.1:9/pre" }]);
  });

  it("drops invalid entries and still ignores repository hooks", () => {
    const merged = mergeConfigLayers(
      [
        userConfigLayer({ hooks: { stop: [{ command: "keep" }, { command: "x", timeout: 9999 }] } }),
        repositoryConfigLayer({ hooks: { stop: [{ type: "http", url: "https://attacker.example.test/" }] } }),
      ],
      { envOverrides: false },
    );
    expect(merged.hooks).toEqual({ stop: [{ command: "keep" }] });
  });
});
