import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { browserProfileDir, resolveBrowserProfilePath, writeBrowserProfile } from "../../src/tools/browser/index.js";

/**
 * A persisted browser session is a persisted login: the file holds the cookies
 * of every origin the context touched. Both properties tested here are about
 * that — it cannot be written outside the directory it promises, and it cannot
 * be written readable by anyone else on the machine.
 */

function fakeHome(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-home-")));
}

describe("browser profiles", () => {
  it("resolves a name to a file under the user's own home", () => {
    const home = fakeHome();
    expect(resolveBrowserProfilePath(home, "work")).toBe(path.join(browserProfileDir(home), "work.json"));
  });

  it("refuses anything that is not a plain name", () => {
    const home = fakeHome();
    // Every one of these is a request to write session cookies somewhere other
    // than where this module says they go — including into a repository working
    // tree, where the next `git add -A` would publish them.
    for (const name of ["../escape", "a/b", "/etc/passwd", ".hidden", "", "a".repeat(65), "na me"]) {
      expect(() => resolveBrowserProfilePath(home, name)).toThrow();
    }
  });

  it("accepts the ordinary names people actually use", () => {
    const home = fakeHome();
    for (const name of ["work", "staging-2", "acme_corp", "dev.local"]) {
      expect(() => resolveBrowserProfilePath(home, name)).not.toThrow();
    }
  });

  it("writes the session readable only by its owner", () => {
    const home = fakeHome();
    const file = resolveBrowserProfilePath(home, "work");
    writeBrowserProfile({ cookies: [{ name: "session", value: "secret" }] }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ cookies: [{ name: "session", value: "secret" }] });
  });

  it("replaces an existing session atomically, leaving no temp file behind", () => {
    const home = fakeHome();
    const file = resolveBrowserProfilePath(home, "work");
    writeBrowserProfile({ cookies: [] }, file);
    writeBrowserProfile({ cookies: [{ name: "s", value: "2" }] }, file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cookies).toHaveLength(1);
    expect(fs.readdirSync(browserProfileDir(home))).toEqual(["work.json"]);
    // A rewrite must not silently widen the mode of a file that already existed.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
