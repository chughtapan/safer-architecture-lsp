/**
 * @file Project barrel. Re-exports the source-model helpers, source
 * paths, source files, and diagnostic / option types that downstream
 * analysis passes consume.
 */

/**
 * Source-model surface the analysis passes work against: module
 * classification predicates, path normalization, set comparison, and the
 * graph types that carry modules and folder edges between passes.
 */
export {
  explicitFacadeModule,
  type ExportConsumer,
  exportedDeclarationName,
  type ExternalModuleEdge,
  type FolderEdge,
  generatedModule,
  hasExportModifier,
  isStarExportDeclaration,
  isTestLikePath,
  jaccardOverlap,
  type LocalModuleEdge,
  type ModuleEdgeKind,
  type ModuleResolutionSnapshotEntry,
  normalizePath,
  type ProjectArchitectureGraph,
  resolveImplementationModule,
  resolveProductionModule,
  type SourceModule,
  unionSets,
} from "./source-model/index.js";
