/**
 * @file Source-model barrel. Re-exports the source-fact predicates,
 * module classification helpers, and graph-model types used by the
 * import-graph construction and downstream analysis passes.
 */

export {
  exportedDeclarationName,
  hasExportModifier,
  isStarExportDeclaration,
  isTestLikePath,
  normalizePath,
} from "./source-facts.js";
export {
  explicitFacadeModule,
  generatedModule,
  jaccardOverlap,
  resolveImplementationModule,
  resolveProductionModule,
  unionSets,
} from "./module-classification.js";
export type {
  ExportConsumer,
  ExternalModuleEdge,
  FolderEdge,
  LocalModuleEdge,
  ModuleEdgeKind,
  ProjectArchitectureGraph,
  SourceModule,
} from "./graph-model.js";
