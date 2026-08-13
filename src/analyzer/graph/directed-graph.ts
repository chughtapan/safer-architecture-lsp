/** A directed edge between two typed string identifiers. */
export interface DirectedEdge<NodeId extends string> {
  readonly from: NodeId;
  readonly to: NodeId;
}

/**
 * Deterministic directed graph index. Node ids and outgoing edges are
 * canonicalized lexicographically so graph algorithms cannot inherit
 * filesystem, parser, or Map insertion order.
 */
export interface DirectedGraph<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
> {
  readonly nodeIds: readonly NodeId[];
  readonly edges: readonly Edge[];
  readonly outgoing: ReadonlyMap<NodeId, readonly Edge[]>;
}

export function makeDirectedGraph<
  NodeId extends string,
  Edge extends DirectedEdge<NodeId>,
>(nodeIds: readonly NodeId[], edges: readonly Edge[]): DirectedGraph<NodeId, Edge> {
  const allNodeIds = new Set<NodeId>(nodeIds);
  for (const edge of edges) {
    allNodeIds.add(edge.from);
    allNodeIds.add(edge.to);
  }

  const sortedNodeIds = [...allNodeIds].sort(compareNodeIds);
  const sortedEdges = [...edges].sort(compareEdges);
  const outgoing = new Map<NodeId, Edge[]>();
  for (const nodeId of sortedNodeIds) {outgoing.set(nodeId, []);}
  for (const edge of sortedEdges) {outgoing.get(edge.from)?.push(edge);}

  return {
    nodeIds: sortedNodeIds,
    edges: sortedEdges,
    outgoing,
  };
}

function compareNodeIds<NodeId extends string>(left: NodeId, right: NodeId): number {
  return left.localeCompare(right);
}

function compareEdges<NodeId extends string, Edge extends DirectedEdge<NodeId>>(
  left: Edge,
  right: Edge,
): number {
  const fromComparison = left.from.localeCompare(right.from);
  return fromComparison === 0 ? left.to.localeCompare(right.to) : fromComparison;
}
