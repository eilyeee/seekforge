import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/tools/index.js";

describe("redactSecrets", () => {
  it("masks well-known token prefixes, keeping the first 4 chars", () => {
    const cases: Array<[string, string]> = [
      ["sk-abcdefghijklmnop1234", "sk-a****"],
      ["pk-abcdefghijklmnop1234", "pk-a****"],
      ["rk-abcdefghijklmnop1234", "rk-a****"],
      ["ghp_abcdefghijklmnopqrst", "ghp_****"],
      ["gho_abcdefghijklmnopqrst", "gho_****"],
      ["ghs_abcdefghijklmnopqrst", "ghs_****"],
      ["ghu_abcdefghijklmnopqrst", "ghu_****"],
      ["ghr_abcdefghijklmnopqrst", "ghr_****"],
      ["github_pat_11AA22bb33CC44dd55EE", "gith****"],
      ["xoxb-1234-abcdefghijklmnop", "xoxb****"],
      ["xoxp-1234-abcdefghijklmnop", "xoxp****"],
      ["AKIAIOSFODNN7EXAMPLE", "AKIA****"],
      ["AIzaSyD-abcdefghijklmnop", "AIza****"],
    ];
    for (const [token, masked] of cases) {
      const out = redactSecrets(`token is ${token} here`);
      expect(out, token).not.toContain(token);
      expect(out, token).toContain(masked);
    }
  });

  it("masks env-style assignments by variable name", () => {
    const out = redactSecrets(
      "DEEPSEEK_API_KEY=verysecretvalue\nMY_TOKEN: 'anothersecret'\nGITHUB_PAT=github_pat_11AA22bb33CC44dd55EE",
    );
    expect(out).not.toContain("verysecretvalue");
    expect(out).toContain("DEEPSEEK_API_KEY=very****");
    expect(out).not.toContain("anothersecret");
    expect(out).not.toContain("github_pat_11AA22bb33CC44dd55EE");
  });

  it("masks PEM private key blocks", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7czou3GbRtnyD8N7Vt0Y",
      "x9eDhYTGVeRzS1L2qkU5XYZ12345abcdef==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(`before\n${pem}\nafter`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA7czou3GbRtnyD8N7Vt0Y");
    expect(out).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(out).toContain("-----END RSA PRIVATE KEY-----");
    expect(out).toContain("****");
  });

  it("masks high-entropy generic key/password assignments", () => {
    const out = redactSecrets('password = "Xy9zKq2mNp8rTw4vBh6J"');
    expect(out).not.toContain("Xy9zKq2mNp8rTw4vBh6J");
    expect(out).toContain("Xy9z****");
  });

  it("leaves low-entropy and unrelated values alone", () => {
    expect(redactSecrets("password = aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("password = aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(redactSecrets("the keyboard layout = de_DE and that is fine")).toContain("keyboard");
    expect(redactSecrets("plain text without secrets")).toBe("plain text without secrets");
  });
});
