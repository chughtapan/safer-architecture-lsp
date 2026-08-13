/**
 * @file Project barrel. Re-exports the source-model helpers, source
 * paths, source files, and diagnostic / option types that downstream
 * analysis passes consume.
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
