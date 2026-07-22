/**
 * @file Imports analysis barrel. Public facade for the import-graph
 * builder, folder-cycle/root-cycle/cross-domain/distance/upward-layer
 * checks, and graph type re-exports.
 */

export {
  buildProjectGraph,
} from "./project-graph/index.js";
export type {
  ExportConsumer,
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "../project/index.js";
export {
  checkFolderGraph,
} from "./folder-graph/index.js";
