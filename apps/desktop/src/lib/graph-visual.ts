export type VisualGraphNode = {
  id: string;
  kind: string;
  dependsOn: string[];
  x: number;
  y: number;
};

export type VisualGraphEdge = { from: string; to: string };

export type VisualGraph = {
  nodes: VisualGraphNode[];
  edges: VisualGraphEdge[];
  width: number;
  height: number;
  warnings: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GRAPH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function graphContainer(
  definition: unknown,
): { nodes: unknown[]; replace: (nodes: unknown[]) => Record<string, unknown> } | undefined {
  if (!record(definition)) return undefined;
  if (Array.isArray(definition.nodes))
    return { nodes: definition.nodes, replace: (nodes) => ({ ...definition, nodes }) };
  const nested = definition.definition;
  if (definition.kind === "engineering-graph-template" && record(nested) && Array.isArray(nested.nodes)) {
    return {
      nodes: nested.nodes,
      replace: (nodes) => ({ ...definition, definition: { ...nested, nodes } }),
    };
  }
  return undefined;
}

function collectConditionReferences(value: unknown, references: Set<string>, depth = 0): void {
  if (depth > 8 || !record(value)) return;
  if (typeof value.nodeId === "string") references.add(value.nodeId);
  if (record(value.not)) collectConditionReferences(value.not, references, depth + 1);
  for (const group of [value.all, value.any]) {
    if (Array.isArray(group)) for (const child of group) collectConditionReferences(child, references, depth + 1);
  }
}

function nodeReferences(node: Record<string, unknown>, includeDependencies: boolean): Set<string> {
  const references = new Set<string>();
  if (includeDependencies && Array.isArray(node.dependsOn)) {
    for (const id of node.dependsOn) if (typeof id === "string") references.add(id);
  }
  if (Array.isArray(node.compensates)) {
    for (const id of node.compensates) if (typeof id === "string") references.add(id);
  }
  if (record(node.route) && typeof node.route.routerId === "string") references.add(node.route.routerId);
  if (record(node.inputs)) {
    for (const binding of Object.values(node.inputs)) {
      if (record(binding) && typeof binding.nodeId === "string") references.add(binding.nodeId);
    }
  }
  if (record(node.source) && typeof node.source.nodeId === "string") references.add(node.source.nodeId);
  collectConditionReferences(node.condition, references);
  if (Array.isArray(node.routes)) {
    for (const route of node.routes) if (record(route)) collectConditionReferences(route.when, references);
  }
  return references;
}

/** Builds a deterministic, cycle-tolerant layered layout for the desktop editor. */
export function buildVisualGraph(definition: unknown): VisualGraph {
  const container = graphContainer(definition);
  if (!container) {
    return { nodes: [], edges: [], width: 320, height: 120, warnings: ["Graph definition needs a nodes array"] };
  }
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const seenIds = new Set<string>();
  if (container.nodes.length > 128) warn("Only the first 128 nodes are shown");
  const raw = container.nodes.slice(0, 128).filter((node): node is Record<string, unknown> => {
    if (!record(node) || typeof node.id !== "string" || typeof node.kind !== "string" || !GRAPH_ID_RE.test(node.id)) {
      warn("An invalid node was ignored");
      return false;
    }
    if (seenIds.has(node.id)) {
      warn(`Duplicate node id ${node.id} was ignored`);
      return false;
    }
    seenIds.add(node.id);
    return true;
  });
  const ids = new Set(raw.map((node) => node.id as string));
  const nodes = raw.map((node) => {
    const id = node.id as string;
    const kind = node.kind as string;
    const validDependencies = Array.isArray(node.dependsOn)
      ? node.dependsOn.filter((id): id is string => typeof id === "string" && ids.has(id))
      : [];
    const dependsOn = [...new Set(validDependencies)];
    if (Array.isArray(node.dependsOn) && dependsOn.length !== node.dependsOn.length) {
      warn(`${id} has an invalid or duplicate dependency`);
    }
    return { id, kind, dependsOn };
  });
  const layerById = new Map<string, number>();
  let pending = [...nodes];
  while (pending.length > 0) {
    const ready = pending.filter((node) => node.dependsOn.every((id) => layerById.has(id)));
    if (ready.length === 0) {
      warn("Cycle detected; cyclic nodes were placed in a fallback layer");
      const fallback = Math.max(0, ...layerById.values()) + 1;
      for (const node of pending) layerById.set(node.id, fallback);
      break;
    }
    for (const node of ready) {
      layerById.set(
        node.id,
        node.dependsOn.length === 0 ? 0 : Math.max(...node.dependsOn.map((id) => layerById.get(id)!)) + 1,
      );
    }
    const readyIds = new Set(ready.map((node) => node.id));
    pending = pending.filter((node) => !readyIds.has(node.id));
  }
  const layers = new Map<number, typeof nodes>();
  for (const node of nodes) {
    const layer = layerById.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const positioned = [...layers.entries()].flatMap(([layer, items]) =>
    items
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((node, row) => ({ ...node, x: 30 + layer * 190, y: 30 + row * 80 })),
  );
  const edges = positioned.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })));
  const maxLayer = Math.max(0, ...layerById.values());
  const maxRows = Math.max(1, ...Array.from(layers.values(), (items) => items.length));
  return { nodes: positioned, edges, width: 60 + (maxLayer + 1) * 190, height: 40 + maxRows * 80, warnings };
}

export function appendGraphNode(definition: unknown, node: { id: string; kind: string; dependsOn: string[] }): unknown {
  const container = graphContainer(definition);
  if (!container) throw new Error("Graph definition needs a nodes array");
  if (!GRAPH_ID_RE.test(node.id)) throw new Error("Node id is invalid");
  if (!["function", "agent", "loop", "gate", "join", "router", "wait"].includes(node.kind)) {
    throw new Error("Node kind is invalid");
  }
  if (container.nodes.some((item) => record(item) && item.id === node.id)) throw new Error("Node id already exists");
  const known = new Set(
    container.nodes.flatMap((item) => (record(item) && typeof item.id === "string" ? [item.id] : [])),
  );
  if (node.dependsOn.some((dependency) => !known.has(dependency))) throw new Error("A dependency does not exist");
  if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error("Dependencies must be unique");
  if (node.kind === "join" && node.dependsOn.length === 0) throw new Error("Join nodes require a dependency");
  const created: Record<string, unknown> = { id: node.id, kind: node.kind };
  if (node.dependsOn.length > 0) created.dependsOn = node.dependsOn;
  if (node.kind === "function") created.handler = "noop";
  if (node.kind === "agent") {
    created.task = "Describe the task";
    created.mode = "edit";
    created.approvalMode = "confirm";
  }
  if (node.kind === "loop") {
    created.task = "Repair until verification passes";
    created.verifyCommand = "pnpm test";
  }
  if (node.kind === "router") created.routes = [{ id: "default" }];
  if (node.kind === "wait") created.waitFor = { signal: `${node.id}-ready` };
  return container.replace([...container.nodes, created]);
}

export function setGraphNodeDependencies(definition: unknown, nodeId: string, dependsOn: string[]): unknown {
  const container = graphContainer(definition);
  if (!container) throw new Error("Graph definition needs a nodes array");
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error("Dependencies must be unique");
  if (dependsOn.includes(nodeId)) throw new Error("A node cannot depend on itself");
  const known = new Set(
    container.nodes.flatMap((item) => (record(item) && typeof item.id === "string" ? [item.id] : [])),
  );
  if (!known.has(nodeId)) throw new Error("Node does not exist");
  if (dependsOn.some((dependency) => !known.has(dependency))) throw new Error("A dependency does not exist");
  const nodes = container.nodes.map((item) => {
    if (!record(item) || item.id !== nodeId) return item;
    const required = nodeReferences(item, false);
    if ([...required].some((reference) => reference !== nodeId && !dependsOn.includes(reference))) {
      throw new Error("Dependencies must retain references used by node inputs, routes, or conditions");
    }
    const { dependsOn: _previous, ...rest } = item;
    return dependsOn.length > 0 ? { ...rest, dependsOn } : rest;
  });
  return container.replace(nodes);
}

export function removeGraphNode(definition: unknown, nodeId: string): unknown {
  const container = graphContainer(definition);
  if (!container) throw new Error("Graph definition needs a nodes array");
  if (container.nodes.length <= 1) throw new Error("A Graph must retain at least one node");
  if (!container.nodes.some((item) => record(item) && item.id === nodeId)) throw new Error("Node does not exist");
  for (const item of container.nodes) {
    if (!record(item) || item.id === nodeId) continue;
    const references = nodeReferences(item, true);
    if (references.has(nodeId)) throw new Error("Remove dependent references before deleting this node");
  }
  return container.replace(container.nodes.filter((item) => !record(item) || item.id !== nodeId));
}
