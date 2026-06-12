import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, type ToolSpec } from "../registry.js";

type PackageJson = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(workspace: string): PackageJson | undefined {
  const p = path.join(workspace, "package.json");
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

const detectProject = defineTool({
  name: "detect_project",
  description:
    "Inspect the workspace root and report languages, package manager, frameworks (vue/react/next), and npm scripts. Make this your FIRST call when you need to know how to build, run, or test the project — cheaper than guessing commands.",
  schema: z.object({}),
  classify: () => ({ permission: "readonly", description: "Detect project type", path: "." }),
  async run(_args, ctx) {
    const ws = ctx.workspace;
    const has = (name: string): boolean => fs.existsSync(path.join(ws, name));
    const pkg = readPackageJson(ws);

    const languages: string[] = [];
    if (pkg) {
      languages.push(has("tsconfig.json") ? "typescript" : "javascript");
    }
    if (has("Cargo.toml")) languages.push("rust");
    if (has("pyproject.toml")) languages.push("python");
    if (has("go.mod")) languages.push("go");

    let packageManager: string | undefined;
    if (pkg?.packageManager) {
      packageManager = pkg.packageManager.split("@")[0];
    } else if (has("pnpm-lock.yaml")) packageManager = "pnpm";
    else if (has("yarn.lock")) packageManager = "yarn";
    else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
    else if (has("package-lock.json")) packageManager = "npm";

    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const frameworks = ["vue", "react", "next"].filter((f) => f in deps);

    return {
      data: {
        name: pkg?.name,
        languages,
        packageManager,
        frameworks,
        scripts: pkg?.scripts ?? {},
      },
    };
  },
});

const listScripts = defineTool({
  name: "list_scripts",
  description:
    "List the workspace package.json scripts as {name, command} pairs — the quickest way to learn how to run, build, or test a Node project before reaching for run_command.",
  schema: z.object({}),
  classify: () => ({ permission: "readonly", description: "List package.json scripts", path: "package.json" }),
  async run(_args, ctx) {
    const pkg = readPackageJson(ctx.workspace);
    const scripts = Object.entries(pkg?.scripts ?? {}).map(([name, command]) => ({
      name,
      command,
    }));
    return { data: { scripts } };
  },
});

export const projectTools: ToolSpec[] = [detectProject, listScripts];
