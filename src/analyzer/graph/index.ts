/**
 * @file Public graph surface. Cycle detection and graph construction are
 * consumed through this facade so callers do not depend on which module
 * implements Tarjan's algorithm.
 */

/** Deterministic graph construction. */
export { makeDirectedGraph } from "./directed-graph.js";
/** Cycle detection and canonical cycle-path selection. */
export {
  canonicalCyclePath,
  cyclicStronglyConnectedComponents,
  stronglyConnectedComponents,
} from "./strongly-connected-components.js";
