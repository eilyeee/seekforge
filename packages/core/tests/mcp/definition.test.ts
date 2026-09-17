import { describe, expect, it } from "vitest";
import {
  parseMcpEnvAssignment,
  parseMcpHeaderAssignment,
  parseMcpServerDefinition,
  validateMcpServerName,
} from "../../src/mcp/definition.js";
import { rankToolSearch, toolSearchDescription } from "../../src/mcp/meta-tools.js";

describe("parseMcpServerDefinition", () => {
  it("accepts Claude Code's stdio, http and sse shapes", () => {
    expect(parseMcpServerDefinition({ type: "stdio", command: "npx", args: ["-y", "pkg"], env: {} }).config).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
    });
    expect(
      parseMcpServerDefinition({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${T}" },
      }).config,
    ).toEqual({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${T}" } });
    expect(parseMcpServerDefinition({ type: "sse", url: "https://${HOST}/sse" }).config).toEqual({
      type: "sse",
      url: "https://${HOST}/sse",
    });
    expect(
      parseMcpServerDefinition({ url: "http://127.0.0.1:3000/mcp", trusted: true, permission: "env" }).config,
    ).toEqual({
      url: "http://127.0.0.1:3000/mcp",
      trusted: true,
      permission: "env",
    });
  });

  it("rejects what cannot work", () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /JSON object/],
      [{ command: "x", extra: 1 }, /unsupported field\(s\): extra/],
      [{ type: "ws", url: "wss://x" }, /type must be/],
      [{}, /needs a command/],
      [{ command: "x", url: "https://a" }, /not command/],
      [{ type: "stdio", command: "x", url: "https://a" }, /not a url/],
      [{ type: "http" }, /needs a url/],
      [{ type: "sse", url: "https://a", command: "x" }, /not command/],
      [{ url: "ftp://a" }, /absolute http/],
      [{ url: "relative/path" }, /absolute http/],
      [{ command: "x", headers: { a: "b" } }, /only to http/],
      [{ command: "x", args: [1] }, /array of strings/],
      [{ command: "x", env: { "BAD-NAME": "v" } }, /not a valid variable name/],
      [{ url: "https://a", headers: { "bad name": "v" } }, /not a valid header name/],
      [{ command: "x", permission: "root" }, /permission must be/],
      [{ command: "x", toolPermissions: { t: "root" } }, /toolPermissions/],
      [{ url: "https://a", oauth: { clientId: "c" } }, /oauth needs/],
      [{ command: "x", trusted: "yes" }, /trusted must be a boolean/],
    ];
    for (const [value, message] of cases) {
      expect(() => parseMcpServerDefinition(value), JSON.stringify(value)).toThrow(message);
    }
  });

  it("drops unknown fields on request and says which", () => {
    expect(
      parseMcpServerDefinition({ command: "x", disabled: false, alwaysAllow: [] }, { unknownFields: "drop" }),
    ).toEqual({
      config: { command: "x" },
      dropped: ["disabled", "alwaysAllow"],
    });
  });
});

describe("command-line assignments", () => {
  it("parses KEY=VALUE and header forms", () => {
    expect(parseMcpEnvAssignment("TOKEN=a=b")).toEqual(["TOKEN", "a=b"]);
    expect(() => parseMcpEnvAssignment("=x")).toThrow(/KEY=VALUE/);
    expect(() => parseMcpEnvAssignment("NOEQUALS")).toThrow(/KEY=VALUE/);
    expect(parseMcpHeaderAssignment("Authorization: Bearer a:b=c")).toEqual(["Authorization", "Bearer a:b=c"]);
    expect(parseMcpHeaderAssignment("X-Key=v:1")).toEqual(["X-Key", "v:1"]);
    expect(() => parseMcpHeaderAssignment("no separator")).toThrow(/Name: value/);
  });

  it("validates server names", () => {
    expect(validateMcpServerName("  docs ")).toBe("docs");
    expect(() => validateMcpServerName(" ")).toThrow(/empty/);
    expect(() => validateMcpServerName("a\nb")).toThrow(/control/);
    expect(() => validateMcpServerName("x".repeat(129))).toThrow(/at most/);
  });
});

describe("tool search helpers", () => {
  const catalog = ["mcp__gh__create_issue", "mcp__gh__list_issues", "mcp__jira__create_ticket"].map((name) => ({
    definition: { name, description: name.includes("jira") ? "File an issue in Jira" : "GitHub", parameters: {} },
    summary: "",
  }));

  it("ranks exact name segments above substrings above descriptions, and honors +required", () => {
    expect(rankToolSearch("issue", catalog, 5)).toEqual([
      "mcp__gh__create_issue",
      "mcp__gh__list_issues",
      "mcp__jira__create_ticket",
    ]);
    expect(rankToolSearch("create +jira", catalog, 5)).toEqual(["mcp__jira__create_ticket"]);
    expect(rankToolSearch("nothing", catalog, 5)).toEqual([]);
    expect(rankToolSearch("create", catalog, 1)).toEqual(["mcp__gh__create_issue"]);
  });

  it("bounds the deferred index", () => {
    const index = Array.from({ length: 2000 }, (_, i) => ({ name: `mcp__s__tool${i}`, summary: "y".repeat(300) }));
    const description = toolSearchDescription(index);
    expect(description.length).toBeLessThan(17_000);
    expect(description).toMatch(/…and \d+ more \(search by keyword\)$/);
    expect(toolSearchDescription([])).not.toContain("Deferred MCP tools");
  });
});
