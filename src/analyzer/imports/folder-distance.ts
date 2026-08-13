/**
 * @file The `no-distant-folder-import` check. Distance is counted as path
 * segments walked up to the shared ancestor and back down again, so reaching
 * into a far corner of the tree costs more than a neighbouring import.
 * Test-like and generated modules are exempt because their reach reflects a
 * harness or a code generator, not a design decision.
 */

import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import type {
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "./project-graph/index.js";

/**
 * Report every import that crosses more folder hops than the configured
 * budget allows. Only `import` edges are measured, because a re-export through
 * a nearer facade is the documented fix for a long reach rather than another
 * instance of it.
 * @param graph Modules and their resolved local edges.
 * @param options Supplies the folder-hop budget the measured distance is compared against.
 * @returns One warning per over-budget import, naming both folders so the reader knows which facade is missing.
 */
export function distantFolderImportDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.localEdges.flatMap((edge) =>
    distantFolderImportDiagnostic(graph, options, edge)
  );
}

function folderDistance(left: string, right: string): number {
  const leftSegments = folderSegments(left);
  const rightSegments = folderSegments(right);
  const sharedPrefixLength = commonPrefixLength(leftSegments, rightSegments);
  return leftSegments.length + rightSegments.length - (2 * sharedPrefixLength);
}

function distantFolderImportDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  edge: LocalModuleEdge,
): readonly ArchitectureDiagnostic[] {
  if (edge.kind !== "import") {return [];}
  const pair = modulePair(graph, edge);
  if (pair === null || ignoredModulePair(pair.fromModule, pair.toModule)) {return [];}
  const distance = folderDistance(pair.fromModule.folder, pair.toModule.folder);
  if (distance <= options.maxFolderImportDistance) {return [];}
  return [distantImportDiagnostic(pair.fromModule, pair.toModule, distance, options)];
}

function ignoredModulePair(fromModule: SourceModule, toModule: SourceModule): boolean {
  return fromModule.isTestLike ||
    toModule.isTestLike ||
    generatedModule(fromModule) ||
    generatedModule(toModule);
}

function distantImportDiagnostic(
  fromModule: SourceModule,
  toModule: SourceModule,
  distance: number,
  options: ResolvedArchitectureOptions,
): ArchitectureDiagnostic {
  return {
    ruleId: "no-distant-folder-import",
    file: fromModule.fileName,
    severity: "warn",
    message:
      `${fromModule.relativePath} imports ${toModule.relativePath} across ` +
      `${distance} folder hops (max ${options.maxFolderImportDistance}). ` +
      `Use a nearer facade/port instead of reaching from ` +
      `${sourceFolderPath(fromModule.folder)} into ${sourceFolderPath(toModule.folder)}.`,
  };
}

function folderSegments(folder: string): readonly string[] {
  return folder === "." ? [] : folder.split("/");
}

function commonPrefixLength(
  leftSegments: readonly string[],
  rightSegments: readonly string[],
): number {
  let index = 0;
  while (
    index < leftSegments.length &&
    index < rightSegments.length &&
    leftSegments[index] === rightSegments[index]
  ) {
    index += 1;
  }
  return index;
}

function modulePair(
  graph: ProjectArchitectureGraph,
  edge: LocalModuleEdge,
): { readonly fromModule: SourceModule; readonly toModule: SourceModule } | null {
  const fromModule = graph.modulesByFileName.get(edge.from);
  const toModule = graph.modulesByFileName.get(edge.to);
  return fromModule && toModule ? { fromModule, toModule } : null;
}

function generatedModule(module: SourceModule): boolean {
  return /(^|\/)(__generated__|generated)(\/|$)/.test(module.relativePath) ||
    /\.(generated|gen)\.[cm]?[tj]sx?$/.test(module.relativePath);
}

function sourceFolderPath(folder: string): string {
  return folder === "." ? "src" : `src/${folder}`;
}
