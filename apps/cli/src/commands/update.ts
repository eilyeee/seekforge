// `seekforge update` / `upgrade` — check npm for a newer release, work out how
// this copy was installed, and (after confirmation, or with -y) run that
// package manager's upgrade, printing the exact command first. An install we
// cannot classify gets the old behavior: the command to run by hand, because
// running the wrong manager against a global install can corrupt it.
//
// Replacing the files of the running CLI is safe here: the bundle is already
// loaded, and nothing is imported after the upgrade finishes.

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dim, fail, green } from "../colors.js";
import { t } from "../i18n.js";
import { detectInstallMethod, upgradeCommand, type InstallMethod, type UpgradeCommand } from "../install-method.js";
import { checkForUpdate } from "../version-check.js";
import { createDefaultProbes } from "./doctor.js";

export type UpdateOptions = { yes?: boolean };

export type UpdateDeps = {
  currentVersion: () => string;
  latestVersion: (current: string) => Promise<string | null>;
  installMethod: () => { method: InstallMethod; entryPath: string };
  confirm: (question: string) => Promise<boolean>;
  run: (cmd: UpgradeCommand) => Promise<number>;
  interactive: boolean;
};

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function npmGlobalRoot(): string | null {
  try {
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 10_000,
      shell: process.platform === "win32",
    });
    if (result.status !== 0) return null;
    const root = result.stdout.trim();
    return root ? realpathOrSelf(root) : null;
  } catch {
    return null;
  }
}

/**
 * `version` is the entry point's own reading of the package version: it knows
 * where the bundle sits. A path relative to this source file does not survive
 * bundling into dist/, which made every published copy report 0.0.0.
 */
export function defaultUpdateDeps(version: string): UpdateDeps {
  return {
    currentVersion: () => version,
    latestVersion: checkForUpdate,
    installMethod: () => {
      const entryPath = realpathOrSelf(process.argv[1] ?? fileURLToPath(import.meta.url));
      const repoRoot = createDefaultProbes().findRepoRoot(dirname(entryPath));
      const method = detectInstallMethod({
        entryPath,
        repoRoot,
        // Only ask npm when the path could be an npm global at all.
        npmGlobalRoot: repoRoot ? null : npmGlobalRoot(),
      });
      return { method, entryPath };
    },
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(question)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } catch {
        return false;
      } finally {
        rl.close();
      }
    },
    run: (cmd) =>
      new Promise((resolve) => {
        const child = spawn(cmd.command, cmd.args, {
          stdio: "inherit",
          env: { ...process.env, ...cmd.env },
          // npm/pnpm are .cmd shims on Windows, which only start through a shell.
          shell: process.platform === "win32",
        });
        child.once("error", (error) => {
          console.error(error.message);
          resolve(127);
        });
        child.once("close", (code) => resolve(code ?? 1));
      }),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  };
}

export async function updateCommand(opts: UpdateOptions, deps: UpdateDeps): Promise<void> {
  const version = deps.currentVersion();
  const latest = await deps.latestVersion(version);
  if (!latest) {
    console.log(t("status.upToDate", { version }));
    return;
  }
  console.log(`${green(t("status.updateAvailable", { latest }))} ${t("status.currentVersion", { version })}`);
  console.log("");
  const { method, entryPath } = deps.installMethod();
  const cmd = upgradeCommand(method);
  if (!cmd) {
    if (method === "dev") {
      console.log(t("status.updateDevCheckout", { path: entryPath }));
      return;
    }
    console.log(dim(t("status.updateUnknownMethod", { path: entryPath })));
    console.log(t("status.updateWith"));
    console.log(`  ${t("status.npmInstallCmd")}`);
    console.log("");
    console.log(dim(t("status.updateNote")));
    console.log(dim(t("status.updateNote2")));
    return;
  }
  console.log(t("status.updateMethod", { method }));
  console.log(`  ${cmd.display}`);
  if (!opts.yes) {
    if (!deps.interactive || !(await deps.confirm(t("status.updateConfirm")))) {
      console.log(dim(t("status.updateSkipped")));
      return;
    }
  }
  console.log(dim(t("status.updateRunning", { cmd: cmd.display })));
  const code = await deps.run(cmd);
  if (code !== 0) {
    fail(t("status.updateFailed", { code }));
    return;
  }
  console.log(green(t("status.updateDone", { latest })));
}
