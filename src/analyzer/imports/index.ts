/**
 * @file Imports analysis barrel. Public facade for the import-graph
 * builder, folder-cycle/root-cycle/cross-domain/distance/upward-layer
 * checks, and graph type re-exports.
 */

/**
 * Graph vocabulary re-exported so callers can name what the checks operate on
 * without importing the project model directly.
 */
export type {
  ExportConsumer,
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "../project/index.js";
/** The whole folder-level rule family, run as one pass over a built graph. */
export {
  checkFolderGraph,
} from "./folder-graph/index.js";
/** Graph construction, which every check in this folder takes as its input. */
export {
  buildProjectGraph,
} from "./project-graph/index.js";
