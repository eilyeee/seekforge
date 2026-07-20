import { describe, expect, it } from "vitest";
import { isSecretEnvName, scrubSecretEnv } from "../../src/util/scrub-env.js";

describe("scrubSecretEnv", () => {
  it("drops credential-looking variables, keeps ordinary build env", () => {
    const scrubbed = scrubSecretEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      NODE_ENV: "test",
      CI: "1",
      DEEPSEEK_API_KEY: "sk-secret",
      ARK_API_KEY: "ark-secret",
      GITHUB_TOKEN: "ghp_x",
      MY_SECRET: "s",
      DB_PASSWORD: "p",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "z",
      AWS_SESSION_TOKEN: "t",
      NPM_TOKEN: "n",
    });
    expect(scrubbed).toEqual({ PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "test", CI: "1" });
  });

  it("classifies names case-insensitively and across separators", () => {
    for (const name of ["api_key", "API-KEY", "SomeToken", "x_secret", "AWS_ACCESS_KEY_ID", "private_key"]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    // Non-secret vars a build may need are preserved (incl. AWS_REGION/PROFILE).
    for (const name of ["PATH", "HOME", "LANG", "AWS_REGION", "AWS_PROFILE", "MONKEY_HOUSE", "KEYBOARD_LAYOUT"]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});
