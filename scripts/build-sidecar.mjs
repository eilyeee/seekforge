import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseRustHost(versionOutput) {
  const host = versionOutput.match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) throw new Error("rustc -vV did not report a host target");
  return host;
}

export function sidecarOutputName(target) {
  return `seekforge-server-${target}${target.includes("windows") ? ".exe" : ""}`;
}

export function buildSidecar({ target = process.env.SIDECAR_TARGET } = {}) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const resolvedTarget =
    target ?? parseRustHost(execFileSync("rustc", ["-vV"], { encoding: "utf8", windowsHide: true }));
  if (!/^[A-Za-z0-9_.-]+$/.test(resolvedTarget)) throw new Error(`invalid sidecar target: ${resolvedTarget}`);

  const source = join(repoRoot, "apps", "cli", "src", "index.ts");
  const output = join(repoRoot, "apps", "desktop", "src-tauri", "binaries", sidecarOutputName(resolvedTarget));
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("bun", ["build", "--compile", source, "--outfile", output], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (!existsSync(output)) throw new Error(`Bun did not produce the expected sidecar: ${output}`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSidecar();
}
