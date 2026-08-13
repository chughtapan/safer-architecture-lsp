/**
 * @file Source-model barrel. Re-exports the source-fact predicates,
 * module classification helpers, and graph-model types used by the
 * import-graph construction and downstream analysis passes.
 */

/** Shape of the architecture graph and everything hanging off it. */
export type {
  ExportConsumer,
  ExternalModuleEdge,
  FolderEdge,
  LocalModuleEdge,
  ModuleEdgeKind,
  ModuleResolutionSnapshotEntry,
  ProjectArchitectureGraph,
  SourceModule,
} from "./graph-model.js";
/** Module role predicates and the set arithmetic the cohesion checks use. */
export {
  explicitFacadeModule,
  generatedModule,
  jaccardOverlap,
  resolveImplementationModule,
  resolveProductionModule,
  unionSets,
} from "./module-classification.js";
/** Path and statement facts read without the type checker. */
export {
  exportedDeclarationName,
  hasExportModifier,
  isStarExportDeclaration,
  isTestLikePath,
  normalizePath,
} from "./source-facts.js";
