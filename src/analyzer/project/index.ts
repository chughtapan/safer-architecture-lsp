/**
 * @file Project barrel. Re-exports the source-model helpers, source
 * paths, source files, and diagnostic / option types that downstream
 * analysis passes consume.
 */

export {
  explicitFacadeModule,
  exportedDeclarationName,
  generatedModule,
  hasExportModifier,
  isStarExportDeclaration,
  isTestLikePath,
  jaccardOverlap,
  normalizePath,
  resolveImplementationModule,
  resolveProductionModule,
  unionSets,
  type ExportConsumer,
  type ExternalModuleEdge,
  type FolderEdge,
  type LocalModuleEdge,
  type ModuleEdgeKind,
  type ProjectArchitectureGraph,
  type SourceModule,
} from "./source-model/index.js";
