import type { DirectedEdge, DirectedGraph } from "./directed-graph.js";

interface TarjanState<NodeId extends string, Edge extends DirectedEdge<NodeId>> {
  nextIndex: number;
  readonly graph: DirectedGraph<NodeId, Edge>;
  readonly stack: NodeId[];
  readonly onStack: Set<NodeId>;
  readonly indices: Map<NodeId, number>;
  readonly lowlinks: Map<NodeId, number>;
  readonly components: NodeId[][];
}

/** Return every SCC in deterministic node order, including acyclic singletons. */
export function stronglyConnectedComponents<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(graph: DirectedGraph<NodeId, Edge>): readonly (readonly NodeId[])[] {
  const state = createTarjanState(graph);
  for (const nodeId of graph.nodeIds) {
    if (!state.indices.has(nodeId)) connectComponent(state, nodeId);
  }
  return state.components.sort(compareComponents);
}

/** Return SCCs that contain a real cycle, including a singleton self-loop. */
export function cyclicStronglyConnectedComponents<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(graph: DirectedGraph<NodeId, Edge>): readonly (readonly NodeId[])[] {
  return stronglyConnectedComponents(graph).filter((component) =>
    component.length > 1 || graph.outgoing.get(component[0])?.some((edge) => edge.to === component[0])
  );
}

/**
 * Select one stable cycle from an SCC. The lexicographically smallest
 * node is the root and sorted DFS edge order determines the returned path.
 */
export function canonicalCyclePath<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(
  graph: DirectedGraph<NodeId, Edge>,
  component: readonly NodeId[],
): readonly NodeId[] {
  const root = [...component].sort(compareNodeIds)[0];
  if (root === undefined) return [];
  const componentNodes = new Set(component);
  const path = findCyclePath(graph, root, root, componentNodes, new Set([root]), [root]);
  return path ?? [];
}

function createTarjanState<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(graph: DirectedGraph<NodeId, Edge>): TarjanState<NodeId, Edge> {
  return {
    nextIndex: 0,
    graph,
    stack: [],
    onStack: new Set<NodeId>(),
    indices: new Map<NodeId, number>(),
    lowlinks: new Map<NodeId, number>(),
    components: [],
  };
}

function connectComponent<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId): void {
  state.indices.set(nodeId, state.nextIndex);
  state.lowlinks.set(nodeId, state.nextIndex);
  state.nextIndex += 1;
  state.stack.push(nodeId);
  state.onStack.add(nodeId);

  for (const edge of state.graph.outgoing.get(nodeId) ?? []) {
    visitNeighbor(state, nodeId, edge.to);
  }
  completeComponent(state, nodeId);
}

function visitNeighbor<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId, neighbor: NodeId): void {
  if (!state.indices.has(neighbor)) {
    connectComponent(state, neighbor);
    updateLowlink(state, nodeId, state.lowlinks.get(neighbor));
    return;
  }
  if (state.onStack.has(neighbor)) {
    updateLowlink(state, nodeId, state.indices.get(neighbor));
  }
}

function updateLowlink<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId, candidate: number | undefined): void {
  const current = state.lowlinks.get(nodeId);
  if (current === undefined || candidate === undefined) return;
  state.lowlinks.set(nodeId, Math.min(current, candidate));
}

function completeComponent<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId): void {
  if (state.lowlinks.get(nodeId) !== state.indices.get(nodeId)) return;
  const component = popComponent(state, nodeId);
  component.sort(compareNodeIds);
  state.components.push(component);
}

function popComponent<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, root: NodeId): NodeId[] {
  const component: NodeId[] = [];
  while (state.stack.length > 0) {
    const next = state.stack.pop();
    if (next === undefined) return component;
    state.onStack.delete(next);
    component.push(next);
    if (next === root) return component;
  }
  return component;
}

function findCyclePath<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(
  graph: DirectedGraph<NodeId, Edge>,
  root: NodeId,
  current: NodeId,
  componentNodes: ReadonlySet<NodeId>,
  visited: ReadonlySet<NodeId>,
  path: readonly NodeId[],
): readonly NodeId[] | null {
  for (const edge of graph.outgoing.get(current) ?? []) {
    if (!componentNodes.has(edge.to)) continue;
    if (edge.to === root) return [...path, root];
    if (visited.has(edge.to)) continue;

    const nextVisited = new Set(visited);
    nextVisited.add(edge.to);
    const found = findCyclePath(
      graph,
      root,
      edge.to,
      componentNodes,
      nextVisited,
      [...path, edge.to],
    );
    if (found !== null) return found;
  }
  return null;
}

function compareNodeIds<NodeId extends string>(left: NodeId, right: NodeId): number {
  return left.localeCompare(right);
}

function compareComponents<NodeId extends string>(
  left: readonly NodeId[],
  right: readonly NodeId[],
): number {
  return (left[0] ?? "").localeCompare(right[0] ?? "");
}
