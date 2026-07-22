/**
 * @file Project-graph construction. Walks source files, builds
 * `SourceModule` records with local and external edges, collapses to
 * folder-level edges, computes export consumers, and assigns layer
 * indices. Every downstream architecture check consumes this graph.
 */

import path from "node:path";
import ts from "typescript";
import { collectModuleEdges } from "../edges.js";
import {
  collectExportConsumers,
  collectExportedSymbolNames,
} from "../module-symbols.js";
import { collectFolderEdges } from "../folder-edges.js";
import { publicApiFileNames } from "../../package-api/index.js";
import {
  hasExportModifier,
  isStarExportDeclaration,
  isTestLikePath,
  normalizePath,
  type ExportConsumer,
  type ProjectArchitectureGraph,
  type SourceModule,
} from "../../project/index.js";
import { withTrailingSeparator } from "../../project/source-paths.js";
import type { LayerDefinition, PackageJson, ResolvedArchitectureOptions } from "../../project/api/index.js";

export type {
  FolderEdge,
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "../../project/index.js";

/**
 * Build the canonical architecture graph for a TypeScript project:
 * one `SourceModule` per source file, their local and external import
 * edges, the folder-level edge collapse, the export-consumer index,
 * and a folder-to-layer index keyed by the configured `layers`. Every
 * downstream architecture check consumes this graph.
 * @param sourceFiles Project source files (post-tsconfig include
 * resolution).
 * @param packageJson Parsed `package.json` used to identify public
 * API files.
 * @param options Resolved architecture options.
 * @param reportFile File path used as the diagnostic target when a
 * finding has no natural single file.
 * @returns The fully-populated project architecture graph.
 */
export function buildProjectGraph(
  sourceFiles: readonly ts.SourceFile[],
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
  reportFile: string,
): ProjectArchitectureGraph {
  const sourceFilesByPath = new Map(
    sourceFiles.map((sourceFile) => [path.resolve(sourceFile.fileName), sourceFile] as const),
  );
  const publicFileNames = new Set(
    publicApiFileNames(sourceFilesByPath, packageJson, options),
  );

  const modules = sourceFiles.map((sourceFile) =>
    sourceModuleFromSourceFile(sourceFile, sourceFilesByPath, publicFileNames, options),
  );
  const modulesByFileName = new Map(
    modules.map((module) => [module.fileName, module] as const),
  );
  const localEdges = modules.flatMap((module) => [...module.localEdges]);
  const externalEdges = modules.flatMap((module) => [...module.externalEdges]);
  const exportConsumers = collectExportConsumers(sourceFiles, sourceFilesByPath);
  const publicModules = modules.filter((module) => module.isPublic);
  const folders = [...new Set(modules.map((module) => module.folder))].sort();

  const folderLayerIndex = new Map<string, number | null>(
    folders.map((folder) => [folder, layerIndexFor(folder, options.layers)] as const),
  );

  return {
    projectRoot: options.projectRoot,
    reportFile,
    modules,
    modulesByFileName,
    publicModules,
    localEdges,
    externalEdges,
    exportConsumers,
    exportConsumersByFileName: consumersByTargetFile(exportConsumers),
    folderEdges: collectFolderEdges(localEdges, modulesByFileName),
    folders,
    folderLayerIndex,
  };
}

/**
 * Resolve which configured layer a folder belongs to. A folder matches
 * a layer if any of the layer's `folders` entries equals the folder or
 * is a segment-aligned path prefix of it. The most-specific (longest)
 * entry wins; length ties resolve to the lower (earlier) layer index.
 * @param folder Folder key (relative to `src/`; root is `.`).
 * @param layers Ordered layer definitions from architecture options.
 * @returns Zero-based layer index, or `null` when no layer matches or
 * no layers are configured.
 */
function layerIndexFor(
  folder: string,
  layers: ReadonlyArray<LayerDefinition>,
): number | null {
  if (layers.length === 0) return null;
  const normalized = folder === "." ? "" : normalizePath(folder);

  let bestLayer: number | null = null;
  let bestEntryLength = -1;

  layers.forEach((layer, layerIndex) => {
    for (const entry of layer.folders) {
      const normalizedEntry = entry === "." ? "" : normalizePath(entry);
      const matches =
        normalizedEntry === normalized ||
        (normalizedEntry !== "" && normalized.startsWith(`${normalizedEntry}/`));
      if (!matches) continue;
      if (normalizedEntry.length > bestEntryLength) {
        bestEntryLength = normalizedEntry.length;
        bestLayer = layerIndex;
      }
    }
  });

  return bestLayer;
}

/**
 * Canonical folder key for a source file: directory path relative to
 * `src/` (when the file lives under `src/`) or relative to the project
 * root (otherwise). The root folder is encoded as `.`.
 * @param fileName Absolute or relative path to the source file.
 * @param projectRoot Absolute path to the project root.
 * @returns Folder key with forward-slash separators; `.` for root.
 */
function folderKeyForFile(fileName: string, projectRoot: string): string {
  const sourceRoot = path.join(projectRoot, "src");
  const sourceRootWithSlash = withTrailingSeparator(sourceRoot);
  const resolved = path.resolve(fileName);
  const base = resolved.startsWith(sourceRootWithSlash) ? sourceRoot : projectRoot;
  const relativeDirectory = path.relative(base, path.dirname(resolved));
  return relativeDirectory.length === 0 ? "." : normalizePath(relativeDirectory);
}

/**
 * Top-level folder segment for a folder key — the first path
 * component, used by layer-direction and shared-kernel checks.
 * @param folder Folder key from `folderKeyForFile`.
 * @returns The first segment of `folder`, or `.` for the root folder.
 */
function topFolder(folder: string): string {
  return folder.split("/")[0] ?? ".";
}

function sourceModuleFromSourceFile(
  sourceFile: ts.SourceFile,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
  publicFileNames: ReadonlySet<string>,
  options: ResolvedArchitectureOptions,
): SourceModule {
  const fileName = path.resolve(sourceFile.fileName);
  const folder = folderKeyForFile(fileName, options.projectRoot);
  const edges = collectModuleEdges(sourceFile, sourceFilesByPath);

  return {
    fileName,
    relativePath: normalizePath(path.relative(options.projectRoot, fileName)),
    folder,
    topFolder: topFolder(folder),
    isIndex: path.parse(fileName).name === "index",
    isPublic: publicFileNames.has(fileName),
    isTestLike: isTestLikePath(fileName),
    localEdges: edges.localEdges,
    externalEdges: edges.externalEdges,
    exportedSymbols: collectExportedSymbolNames(sourceFile),
    exportedSymbolCount: countExportedSymbols(sourceFile),
    localReexportCount: edges.localEdges.filter((edge) => edge.kind === "reexport").length,
    starExportCount: sourceFile.statements.filter(isStarExportDeclaration).length,
    topLevelStatementCount: countNonImportTopLevelStatements(sourceFile),
  };
}

function countNonImportTopLevelStatements(sourceFile: ts.SourceFile): number {
  return sourceFile.statements.reduce((count, statement) => {
    if (ts.isImportDeclaration(statement)) return count;
    if (ts.isImportEqualsDeclaration(statement)) return count;
    return count + 1;
  }, 0);
}

function consumersByTargetFile(
  exportConsumers: readonly ExportConsumer[],
): ReadonlyMap<string, readonly ExportConsumer[]> {
  const grouped = new Map<string, ExportConsumer[]>();
  for (const consumer of exportConsumers) {
    const consumers = grouped.get(consumer.targetFile) ?? [];
    consumers.push(consumer);
    grouped.set(consumer.targetFile, consumers);
  }
  return grouped;
}

function countExportedSymbols(sourceFile: ts.SourceFile): number {
  return sourceFile.statements.reduce((count, statement) => {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) return count + 1;
      if (ts.isNamedExports(statement.exportClause)) {
        return count + statement.exportClause.elements.length;
      }
      return count + 1;
    }

    if (ts.isExportAssignment(statement)) return count + 1;
    if (!hasExportModifier(statement)) return count;
    if (ts.isVariableStatement(statement)) {
      return count + statement.declarationList.declarations.length;
    }
    return count + 1;
  }, 0);
}
