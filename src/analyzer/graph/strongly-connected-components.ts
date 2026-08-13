/**
 * @file Tarjan strongly-connected-component search. The traversal is iterative
 * because project graphs reach tens of thousands of modules and a recursive
 * implementation exhausts the JavaScript stack.
 */

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

interface DfsFrame<NodeId extends string, Edge extends DirectedEdge<NodeId>> {
  readonly nodeId: NodeId;
  readonly parent: NodeId | null;
  readonly edges: readonly Edge[];
  nextEdge: number;
}

/**
 * Return every SCC in deterministic node order, including acyclic singletons.
 * @param graph Graph to search; its canonical order fixes the result order.
 * @returns One entry per component, each sorted, the list itself sorted.
 */
export function stronglyConnectedComponents<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(graph: DirectedGraph<NodeId, Edge>): ReadonlyArray<readonly NodeId[]> {
  const state = createTarjanState(graph);
  for (const nodeId of graph.nodeIds) {
    if (!state.indices.has(nodeId)) {connectComponents(state, nodeId);}
  }
  return state.components.sort(compareComponents);
}

/**
 * Return SCCs that contain a real cycle, including a singleton self-loop.
 * @param graph Graph to search for cyclic components.
 * @returns Components of two or more nodes, plus self-looping singletons.
 */
export function cyclicStronglyConnectedComponents<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(graph: DirectedGraph<NodeId, Edge>): ReadonlyArray<readonly NodeId[]> {
  return stronglyConnectedComponents(graph).filter((component) =>
    component.length > 1 || graph.outgoing.get(component[0])?.some((edge) => edge.to === component[0])
  );
}

/**
 * Select one stable cycle from an SCC. The lexicographically smallest
 * node is the root and sorted DFS edge order determines the returned path.
 * @param graph Graph the component belongs to, supplying its outgoing edges.
 * @param component Nodes of one strongly connected component.
 * @returns The cycle as a closed path, first node repeated last; empty when
 * the component has no cycle.
 */
export function canonicalCyclePath<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(
  graph: DirectedGraph<NodeId, Edge>,
  component: readonly NodeId[],
): readonly NodeId[] {
  const root = [...component].sort(compareNodeIds)[0];
  if (root === undefined) {return [];}

  const componentNodes = new Set(component);
  const visited = new Set<NodeId>([root]);
  const parent = new Map<NodeId, NodeId>();
  const frames: Array<DfsFrame<NodeId, Edge>> = [frameFor(graph, root, null)];

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === undefined) {break;}
    const edge = frame.edges[frame.nextEdge];
    if (edge === undefined) {
      frames.pop();
      continue;
    }
    frame.nextEdge += 1;
    if (!componentNodes.has(edge.to)) {continue;}
    if (edge.to === root) {return [...pathTo(parent, frame.nodeId), root];}
    if (visited.has(edge.to)) {continue;}
    visited.add(edge.to);
    parent.set(edge.to, frame.nodeId);
    frames.push(frameFor(graph, edge.to, frame.nodeId));
  }
  return [];
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

/**
 * Iterative Tarjan traversal so large project graphs cannot exhaust the JS stack.
 * @param state Mutable search state accumulating indices, lowlinks, components.
 * @param start Node to begin this traversal from.
 */
function connectComponents<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, start: NodeId): void {
  initializeNode(state, start);
  const frames: Array<DfsFrame<NodeId, Edge>> = [frameFor(state.graph, start, null)];

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === undefined) {break;}
    const edge = frame.edges[frame.nextEdge];
    if (edge !== undefined) {
      frame.nextEdge += 1;
      if (!state.indices.has(edge.to)) {
        initializeNode(state, edge.to);
        frames.push(frameFor(state.graph, edge.to, frame.nodeId));
      } else if (state.onStack.has(edge.to)) {
        updateLowlink(state, frame.nodeId, state.indices.get(edge.to));
      }
      continue;
    }

    frames.pop();
    if (frame.parent !== null) {
      updateLowlink(state, frame.parent, state.lowlinks.get(frame.nodeId));
    }
    completeComponent(state, frame.nodeId);
  }
}

function initializeNode<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId): void {
  state.indices.set(nodeId, state.nextIndex);
  state.lowlinks.set(nodeId, state.nextIndex);
  state.nextIndex += 1;
  state.stack.push(nodeId);
  state.onStack.add(nodeId);
}

function frameFor<NodeId extends string, Edge extends DirectedEdge<NodeId>>(
  graph: DirectedGraph<NodeId, Edge>,
  nodeId: NodeId,
  parent: NodeId | null,
): DfsFrame<NodeId, Edge> {
  return { nodeId, parent, edges: graph.outgoing.get(nodeId) ?? [], nextEdge: 0 };
}

function updateLowlink<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId, candidate?: number): void {
  const current = state.lowlinks.get(nodeId);
  if (current === undefined || candidate === undefined) {return;}
  state.lowlinks.set(nodeId, Math.min(current, candidate));
}

function completeComponent<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(state: TarjanState<NodeId, Edge>, nodeId: NodeId): void {
  if (state.lowlinks.get(nodeId) !== state.indices.get(nodeId)) {return;}
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
    if (next === undefined) {return component;}
    state.onStack.delete(next);
    component.push(next);
    if (next === root) {return component;}
  }
  return component;
}

function pathTo<NodeId extends string>(
  parent: ReadonlyMap<NodeId, NodeId>,
  nodeId: NodeId,
): readonly NodeId[] {
  const reversed: NodeId[] = [nodeId];
  let current = nodeId;
  while (parent.has(current)) {
    const next = parent.get(current);
    if (next === undefined) {break;}
    reversed.push(next);
    current = next;
  }
  return reversed.reverse();
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
