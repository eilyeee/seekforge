import type { EngineeringGraphState, GraphArtifact } from "./graph-state.js";

export type EngineeringGraphArtifactCatalogEntry = GraphArtifact & {
  key: string;
  consumers: string[];
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
