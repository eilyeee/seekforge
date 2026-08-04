import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ToolError } from "../errors.js";

/**
 * Where a browser session is allowed to persist itself.
 *
 * A Playwright storage state is not a preference file: it holds the cookies and
 * localStorage of every origin the context touched, which for a logged-in site
 * IS the login. That single fact decides the shape of this module.
 *
 * The setting is a NAME, not a path. A path would let a typo, or a config layer
 * that should never have been trusted with it, drop live session cookies into a
 * repository working tree — where the next `git add -A` publishes them. A name
 * cannot leave the directory this resolves, and the directory is under the
 * user's home, beside the other credential-adjacent state.
 *
 * The name is also what makes the feature usable without an agent: point your
 * own `playwright codegen`/script at the same file, log in as yourself once, and
 * every later run starts already authenticated.
 */

/** Conservative on purpose: this string becomes a filename under the user's home. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Directory holding browser storage states, under the user's own home. */
export function browserProfileDir(home: string): string {
  return join(home, ".seekforge", "browser-profiles");
}

/**
 * Absolute path of one named profile. Rejects anything that is not a plain
 * name — `..`, a separator, an absolute path, a leading dot — rather than
 * normalizing it, because every one of those is a request to write credentials
 * somewhere other than where this module promises to write them.
 */
export function resolveBrowserProfilePath(home: string, name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new ToolError(
      "invalid_browser_profile",
      `browserProfile must be a plain name of letters, digits, dot, dash or underscore (got "${name}")`,
    );
  }
  return join(browserProfileDir(home), `${name}.json`);
}

/**
 * Write a storage state to disk.
 *
 * By hand rather than through Playwright's `storageState({ path })`, because
 * the file mode is the point: this is a login sitting in the user's home
 * directory, and the default 0644 would make every account on the machine a
 * reader of it. Temp file at 0600, then rename, so an interrupted write cannot
 * replace a working session with half a file.
 */
export function writeBrowserProfile(state: unknown, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    // Explicit: writeFileSync's mode applies only when it CREATES the file, so
    // a temp name that somehow survived an earlier crash would keep its mode.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best-effort cleanup of the temp file
    }
    throw error;
  }
}
