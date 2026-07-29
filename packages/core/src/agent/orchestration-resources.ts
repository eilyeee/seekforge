import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";

export type OrchestrationResourceKind = "loop-dag" | "graph";

const markerPath = (kind: OrchestrationResourceKind, id: string): string =>
  `.seekforge/${kind === "loop-dag" ? "loop-dag-archives" : "graph-archives"}/${id}.json`;

export function orchestrationResourcesArchived(
  workspace: string,
  kind: OrchestrationResourceKind,
  id: string,
  generation?: string,
): boolean {
  const raw = readWorkspaceStateFile(workspace, markerPath(kind, id), 8_192);
  if (raw === undefined) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    return (
      isRecord(value) &&
      value.schemaVersion === 1 &&
      ((value.kind === kind && value.id === id) ||
        (kind === "loop-dag" && value.dagId === id && value.kind === undefined && value.id === undefined)) &&
      (generation === undefined || value.generation === generation) &&
      typeof value.archivedAt === "string" &&
      Number.isFinite(Date.parse(value.archivedAt))
    );
  } catch {
    return false;
  }
}

export function archiveOrchestrationResources(
  workspace: string,
  kind: OrchestrationResourceKind,
  id: string,
  generation?: string,
): string {
  const archivedAt = new Date().toISOString();
  writeWorkspaceStateFileAtomic(
    workspace,
    markerPath(kind, id),
    `${JSON.stringify({ schemaVersion: 1, kind, id, archivedAt, ...(generation ? { generation } : {}) }, null, 2)}\n`,
  );
  return archivedAt;
}

export function measureManagedWorktreeDirectory(
  path: string,
  root: string,
  budget = 100_000,
  excludedPaths: ReadonlySet<string> = new Set(),
): { bytes: number; truncated: boolean } {
  const pending = [path];
  let bytes = 0;
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++visited > budget) return { bytes, truncated: true };
    if (current !== path && excludedPaths.has(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      bytes += stat.size;
      continue;
    }
    if (!stat.isDirectory() || !realpathSync.native(current).startsWith(`${root}${sep}`)) continue;
    for (const entry of readdirSync(current)) pending.push(join(current, entry));
  }
  return { bytes, truncated: false };
}
