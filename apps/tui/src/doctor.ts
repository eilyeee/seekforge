/**
 * /doctor — environment diagnostics for the TUI.
 *
 * The engine (DoctorCheck/DoctorProbes, the probe bag, the shared checks,
 * configKeysCheck/configParseCheck, formatDoctorLines) lives in
 * @seekforge/shared/doctor; this module keeps the TUI's composition — its
 * own wording (the /diff affordance, the ctrl-e editor hint, the
 * setup-wizard api-key hint) and the TUI-only project-memory check.
 */
import { join } from "node:path";
import { DEFAULT_BASE_URL, resolveProviderPreset } from "@seekforge/core";
import {
  apiKeyCheck,
  clipboardCheck,
  configKeysCheck,
  configParseCheck,
  createDefaultProbes,
  editorCheck,
  formatDoctorLines,
  gitRepoCheck,
  mcpServersCheck,
  nodeCheck,
  platformCheck,
  projectConfigCheck,
  providerCheck,
  rustRuntimeCheck,
  sessionsCheck,
  type DoctorCheck,
  type DoctorProbes,
} from "@seekforge/shared/doctor";

export type { DoctorCheck, DoctorProbes };
// The shared defaults ARE the TUI wording (plain marks, "→ fix:", the generic
// config-docs hint), so these re-export unchanged.
export { configKeysCheck, configParseCheck, createDefaultProbes, formatDoctorLines };

/**
 * Runs every diagnostic and returns one DoctorCheck per concern. Pure given
 * the probes: no direct fs/env/process access happens here.
 */
export function runDoctor(
  projectPath: string,
  config: {
    apiKey?: string;
    provider?: string;
    baseUrl?: string;
    runtimeBin?: string;
    mcpServers?: Record<string, unknown>;
  },
  probes: DoctorProbes,
): DoctorCheck[] {
  // Active provider preset (default "deepseek"); an explicit baseUrl always wins.
  const provider = (config.provider ?? "deepseek").toLowerCase();
  const preset = resolveProviderPreset(provider);
  const baseUrl = config.baseUrl ?? preset?.baseUrl ?? DEFAULT_BASE_URL;

  return [
    providerCheck(provider, baseUrl),
    apiKeyCheck(
      provider,
      config.apiKey,
      probes.env,
      (keyEnv) => `restart seekforge-tui for the setup wizard, or export ${keyEnv}`,
    ),
    nodeCheck(probes),
    platformCheck(probes),
    gitRepoCheck(projectPath, probes, "/diff"),
    projectConfigCheck(projectPath, probes),
    rustRuntimeCheck(config.runtimeBin, probes),
    mcpServersCheck(config.mcpServers),
    sessionsCheck(projectPath, probes),
    // TUI-only: project memory presence (the CLI has no /memory affordance).
    probes.fileExists(join(projectPath, ".seekforge", "memory", "project.md"))
      ? { name: "project memory", ok: true, detail: ".seekforge/memory/project.md" }
      : { name: "project memory", ok: false, detail: "no .seekforge/memory/project.md — /memory creates one" },
    editorCheck(probes, "$EDITOR/$VISUAL unset — ctrl-e external edit unavailable"),
    clipboardCheck(probes),
  ];
}
