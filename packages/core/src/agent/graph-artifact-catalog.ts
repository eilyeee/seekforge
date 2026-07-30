import type { EngineeringGraphState, GraphArtifact } from "./graph-state.js";
import type { EngineeringGraphRunSnapshot } from "./graph-run-history.js";

export type EngineeringGraphArtifactCatalogEntry = GraphArtifact & {
  key: string;
  consumers: string[];
};

export type EngineeringGraphArtifactReuseCandidate = Omit<GraphArtifact, "sha256" | "sizeBytes" | "verified"> & {
  sha256: string;
  sizeBytes: number;
  verified: true;
  key: string;
  nodeId: string;
  sourceRunNumber: number;
  sourceCompletedAt: string;
};

/** Builds a deterministic, bounded lineage view without reading artifact contents again. */
export function buildEngineeringGraphArtifactCatalog(
  state: EngineeringGraphState,
): EngineeringGraphArtifactCatalogEntry[] {
  const consumersByProducer = new Map<string, string[]>();
  for (const node of state.definition.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      const consumers = consumersByProducer.get(dependency) ?? [];
      consumers.push(node.id);
      consumersByProducer.set(dependency, consumers);
    }
  }
  return state.results
    .flatMap((result) =>
      (result.artifacts ?? []).map((artifact) => ({
        ...artifact,
        producerNodeId: artifact.producerNodeId ?? result.id,
        key: artifact.sha256 ? `sha256:${artifact.sha256}` : `path:${result.id}:${artifact.path}`,
        consumers: [...new Set(consumersByProducer.get(result.id) ?? [])].sort(),
      })),
    )
    .sort((left, right) => left.key.localeCompare(right.key) || left.path.localeCompare(right.path));
}

/** Plans exact-generation reuse; callers must still verify and materialize each artifact explicitly. */
export function planEngineeringGraphArtifactReuse(
  state: EngineeringGraphState,
  runs: readonly EngineeringGraphRunSnapshot[],
): EngineeringGraphArtifactReuseCandidate[] {
  const settled = new Set(state.results.filter((result) => result.status === "passed").map((result) => result.id));
  const candidates = new Map<string, EngineeringGraphArtifactReuseCandidate>();
  for (const run of [...runs].reverse()) {
    if (run.graphId !== state.graphId || run.fingerprint !== state.fingerprint || run.status !== "passed") continue;
    for (const result of run.results) {
      if (settled.has(result.id) || result.status !== "passed") continue;
      for (const artifact of result.artifacts ?? []) {
        if (
          artifact.verified !== true ||
          !artifact.sha256 ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.sizeBytes) ||
          artifact.sizeBytes! < 0
        )
          continue;
        const key = `sha256:${artifact.sha256}`;
        if (!candidates.has(`${result.id}\0${key}`)) {
          candidates.set(`${result.id}\0${key}`, {
            ...artifact,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes!,
            verified: true,
            producerNodeId: artifact.producerNodeId ?? result.id,
            key,
            nodeId: result.id,
            sourceRunNumber: run.runNumber,
            sourceCompletedAt: run.completedAt,
          });
        }
      }
    }
  }
  return [...candidates.values()].sort(
    (left, right) => left.nodeId.localeCompare(right.nodeId) || left.key.localeCompare(right.key),
  );
}
