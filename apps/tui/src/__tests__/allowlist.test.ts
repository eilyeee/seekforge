import { describe, expect, it } from "vitest";
import { sessionAllowPrefix } from "../allowlist.js";

describe("sessionAllowPrefix", () => {
  it("keeps the first two tokens for subcommand-style commands", () => {
    expect(sessionAllowPrefix("npm run build")).toBe("npm run");
    expect(sessionAllowPrefix("git push origin main")).toBe("git push");
  });

  it("drops a second token that looks like a flag", () => {
    expect(sessionAllowPrefix("ls -la")).toBe("ls");
  });

  it("drops a second token that looks like a path or url", () => {
    expect(sessionAllowPrefix("node scripts/x.js")).toBe("node");
    expect(sessionAllowPrefix("curl https://example.com")).toBe("curl");
  });

  it("returns the single token when there is only one", () => {
    expect(sessionAllowPrefix("pwd")).toBe("pwd");
  });

  it("collapses extra whitespace", () => {
    expect(sessionAllowPrefix("  npm    run   build  ")).toBe("npm run");
    expect(sessionAllowPrefix("\tgit\n push  origin")).toBe("git push");
  });

  it("handles empty input", () => {
    expect(sessionAllowPrefix("")).toBe("");
    expect(sessionAllowPrefix("   ")).toBe("");
  });
});
