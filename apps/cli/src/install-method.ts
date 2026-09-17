// How this `seekforge` was installed, read from where its files live, and the
// exact command that upgrades it. Pure given its inputs so every layout is
// testable without installing anything.
//
// The official registry is named explicitly: a user whose default registry is
// a mirror would otherwise "upgrade" to whatever the mirror has synced, which
// can be older than the version `update` just reported.

import { sep } from "node:path";

export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export type InstallMethod = "npm" | "pnpm" | "volta" | "dev" | "unknown";

export type UpgradeCommand = {
  /** argv[0], resolved on PATH. */
  command: string;
  args: string[];
  /** Extra environment for the child (volta has no registry flag). */
  env?: Record<string, string>;
  /** The command as a person would type it. */
  display: string;
};

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function hasSegments(path: string, run: string[]): boolean {
  const parts = segments(path).map((part) => part.toLowerCase());
  for (let i = 0; i + run.length <= parts.length; i++) {
    if (run.every((wanted, j) => parts[i + j] === wanted)) return true;
  }
  return false;
}

/**
 * Classifies the real (symlink-resolved) path of the running entry file.
 * `npmGlobalRoot` is `npm root -g` when known; `repoRoot` a monorepo checkout
 * containing the path, when there is one.
 */
export function detectInstallMethod(input: {
  entryPath: string;
  npmGlobalRoot?: string | null;
  repoRoot?: string | null;
}): InstallMethod {
  const { entryPath } = input;
  if (input.repoRoot) return "dev";
  if (hasSegments(entryPath, [".volta"])) return "volta";
  // pnpm's global store: …/pnpm/global/<n>/node_modules/… (or .pnpm inside it).
  if (hasSegments(entryPath, ["pnpm", "global"])) return "pnpm";
  if (!hasSegments(entryPath, ["node_modules", "seekforge"])) return "unknown";
  // npx and yarn/bun globals have their own upgrade story; don't guess.
  if (hasSegments(entryPath, ["_npx"]) || hasSegments(entryPath, [".bun"]) || hasSegments(entryPath, ["yarn"])) {
    return "unknown";
  }
  const root = input.npmGlobalRoot?.replace(/[\\/]+$/, "");
  if (root && entryPath.startsWith(`${root}${sep}seekforge${sep}`)) return "npm";
  return "unknown";
}

export function upgradeCommand(method: InstallMethod, platform: string = process.platform): UpgradeCommand | null {
  const bin = (name: string): string => (platform === "win32" ? `${name}.cmd` : name);
  switch (method) {
    case "npm":
      return {
        command: bin("npm"),
        args: ["install", "-g", "seekforge@latest", `--registry=${OFFICIAL_NPM_REGISTRY}`],
        display: `npm install -g seekforge@latest --registry=${OFFICIAL_NPM_REGISTRY}`,
      };
    case "pnpm":
      return {
        command: bin("pnpm"),
        args: ["add", "-g", "seekforge@latest", `--registry=${OFFICIAL_NPM_REGISTRY}`],
        display: `pnpm add -g seekforge@latest --registry=${OFFICIAL_NPM_REGISTRY}`,
      };
    case "volta":
      return {
        command: bin("volta"),
        args: ["install", "seekforge@latest"],
        env: { npm_config_registry: OFFICIAL_NPM_REGISTRY },
        display: `npm_config_registry=${OFFICIAL_NPM_REGISTRY} volta install seekforge@latest`,
      };
    default:
      return null;
  }
}
