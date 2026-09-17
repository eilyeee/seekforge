import { describe, expect, it } from "vitest";
import { frontmatterList, parseFrontmatter } from "../../src/subagents/frontmatter.js";

describe("parseFrontmatter — historical scalar behavior", () => {
  it("keeps quoted values, block scalars and lowercased keys as before", () => {
    const parsed = parseFrontmatter(
      '---\nName: "Say \\"hi\\""\ndescription: |-\n  one\n  two\nplain: \'quoted\'\n---\nbody text\n',
    );
    expect(parsed.fields.get("name")).toBe('Say "hi"');
    expect(parsed.fields.get("description")).toBe("one two");
    expect(parsed.fields.get("plain")).toBe("quoted");
    expect(parsed.body).toBe("body text");
    expect(parsed.values.get("name")).toBe('Say "hi"');
  });

  it("still throws without a frontmatter block", () => {
    expect(() => parseFrontmatter("# no frontmatter")).toThrow(/frontmatter/);
  });

  it("keeps an empty key as an empty string", () => {
    const parsed = parseFrontmatter("---\ntools:\nname: x\n---\n");
    expect(parsed.fields.get("tools")).toBe("");
    expect(parsed.values.get("tools")).toBe("");
    expect(frontmatterList(parsed, "tools")).toEqual([]);
  });
});

describe("parseFrontmatter — lists", () => {
  it("reads block lists, indented or at the key's own column", () => {
    const parsed = parseFrontmatter("---\ntools:\n  - Read\n  - \"Grep\"\nskills:\n- one\n- 'two'\nname: after\n---\n");
    expect(parsed.values.get("tools")).toEqual(["Read", "Grep"]);
    expect(parsed.values.get("skills")).toEqual(["one", "two"]);
    // The flat view joins with ", " so comma-splitting consumers keep working.
    expect(parsed.fields.get("tools")).toBe("Read, Grep");
    expect(parsed.fields.get("name")).toBe("after");
  });

  it("reads flow lists, including quoted commas and an empty list", () => {
    const parsed = parseFrontmatter("---\ntools: [Read, \"a, b\", 'c']\nnone: []\n---\n");
    expect(parsed.values.get("tools")).toEqual(["Read", "a, b", "c"]);
    expect(parsed.values.get("none")).toEqual([]);
    expect(frontmatterList(parsed, "none")).toEqual([]);
  });

  it("frontmatterList splits a scalar on the given separator and skips non-strings", () => {
    const parsed = parseFrontmatter("---\ntrigger: a | b\ntools: read_file, glob\nmixed:\n  - x\n  - k: v\n---\n");
    expect(frontmatterList(parsed, "trigger", "|")).toEqual(["a", "b"]);
    expect(frontmatterList(parsed, "tools")).toEqual(["read_file", "glob"]);
    expect(frontmatterList(parsed, "mixed")).toEqual(["x"]);
    expect(frontmatterList(parsed, "absent")).toBeUndefined();
  });

  it("leaves an unbalanced flow value as the historical plain string", () => {
    const parsed = parseFrontmatter("---\ntools: [Read, Grep\n---\n");
    expect(parsed.fields.get("tools")).toBe("[Read, Grep");
  });
});

describe("parseFrontmatter — nested maps", () => {
  it("reads Claude Code's nested hooks shape", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "hooks:",
        "  PreToolUse:",
        '    - matcher: "Bash"',
        "      hooks:",
        "        - type: command",
        "          command: ./check.sh --strict",
        "  Stop:",
        "    - hooks:",
        "        - type: command",
        "          command: |",
        "            echo one",
        "            echo two",
        "name: x",
        "---",
        "",
      ].join("\n"),
    );
    expect(parsed.values.get("hooks")).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh --strict" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo one\necho two" }] }],
    });
    // A block map has no flat form.
    expect(parsed.fields.get("hooks")).toBe("");
    expect(parsed.fields.get("name")).toBe("x");
  });

  it("reads flow maps as JSON or plain YAML, and values containing colons", () => {
    const parsed = parseFrontmatter(
      '---\njson: {"a": [1, true], "b": null}\nyaml: {k: v, n: [x, y]}\nmap:\n  url: http://example.com/a\n---\n',
    );
    expect(parsed.values.get("json")).toEqual({ a: ["1", "true"], b: "" });
    expect(parsed.values.get("yaml")).toEqual({ k: "v", n: ["x", "y"] });
    expect(parsed.values.get("map")).toEqual({ url: "http://example.com/a" });
  });

  it("folds a multi-line plain scalar under an empty key", () => {
    const parsed = parseFrontmatter("---\ndescription:\n  first line\n  second line\n---\n");
    expect(parsed.fields.get("description")).toBe("first line second line");
  });

  it("never assigns prototype keys", () => {
    const parsed = parseFrontmatter('---\nm:\n  __proto__: x\n  ok: y\nj: {"__proto__": {"polluted": "1"}}\n---\n');
    const map = parsed.values.get("m") as Record<string, unknown>;
    expect(Object.keys(map)).toEqual(["ok"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(parsed.values.get("j") as object)).toEqual([]);
  });

  it("bounds nesting depth", () => {
    const lines = ["---", "deep:"];
    for (let i = 1; i <= 40; i++) lines.push(`${"  ".repeat(i)}k${i}:`);
    lines.push(`${"  ".repeat(41)}leaf: v`, "after: ok", "---", "");
    const parsed = parseFrontmatter(lines.join("\n"));
    expect(parsed.fields.get("after")).toBe("ok");
    expect(typeof parsed.values.get("deep")).toBe("object");
  });
});
