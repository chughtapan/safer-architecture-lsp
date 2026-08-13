/**
 * @file The `no-cross-domain-sibling-import` and `no-upward-layer-import`
 * checks. Both read the same importer/importee pair but ask different
 * questions: whether two top-level domains touch each other directly, and
 * whether an import runs against the configured layer order. Layering is the
 * stronger statement, so when both endpoints are layered the sibling check
 * stands down and only the layer check speaks.
 */

import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../../project/api/index.js";
import type {
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "../project-graph/index.js";

interface ModulePair {
  readonly fromModule: SourceModule;
  readonly toModule: SourceModule;
}

/**
 * Report production imports that reach sideways from one top-level domain
 * into another. Root-level files, test-like modules, folders declared as
 * shared kernels, and pairs already governed by layering are all excluded.
 * @param graph Modules, their local edges, and the folder-to-layer index the exclusion consults.
 * @param options Names the top folders treated as shared kernel rather than as domains.
 * @returns One warning per sideways import, naming the two domains involved.
 */
export function crossDomainSiblingImportDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.localEdges.flatMap((edge) =>
    crossDomainSiblingImportDiagnostic(graph, options, edge)
  );
}

/**
 * Report imports that run backward through the configured layer order, that
 * is from a later-listed layer into an earlier-listed one. Yields nothing
 * when no layers are configured, since without an ordering no direction is
 * wrong. Test-like importers are ignored.
 * @param graph Modules, their local edges, and the folder-to-layer index each endpoint is looked up in.
 * @param options Ordered layer definitions; the list order is the permitted dependency direction.
 * @returns One warning per backward import, naming both layers.
 */
export function crossLayerImportDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (options.layers.length === 0) {return [];}

  return graph.localEdges.flatMap((edge) =>
    crossLayerImportDiagnostic(graph, options, edge)
  );
}

function crossDomainSiblingImportDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  edge: LocalModuleEdge,
): readonly ArchitectureDiagnostic[] {
  const pair = importModulePair(graph, edge);
  if (pair === null) {return [];}
  if (!isCrossDomainSiblingPair(pair, options)) {return [];}
  if (bothModulesHaveLayers(graph, pair)) {return [];}
  return [crossDomainSiblingDiagnostic(pair)];
}

function crossLayerImportDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  edge: LocalModuleEdge,
): readonly ArchitectureDiagnostic[] {
  const pair = importModulePair(graph, edge);
  if (pair === null || pair.fromModule.isTestLike) {return [];}
  const fromLayer = moduleLayer(graph, pair.fromModule);
  const toLayer = moduleLayer(graph, pair.toModule);
  if (fromLayer === null || toLayer === null || fromLayer <= toLayer) {return [];}
  return [crossLayerDiagnostic(pair, options, fromLayer, toLayer)];
}

function importModulePair(
  graph: ProjectArchitectureGraph,
  edge: LocalModuleEdge,
): ModulePair | null {
  if (edge.kind !== "import") {return null;}
  const fromModule = graph.modulesByFileName.get(edge.from);
  const toModule = graph.modulesByFileName.get(edge.to);
  return fromModule && toModule ? { fromModule, toModule } : null;
}

function isCrossDomainSiblingPair(
  pair: ModulePair,
  options: ResolvedArchitectureOptions,
): boolean {
  if (pair.fromModule.isTestLike || pair.toModule.isTestLike) {return false;}
  if (pair.fromModule.topFolder === "." || pair.toModule.topFolder === ".") {return false;}
  if (pair.fromModule.topFolder === pair.toModule.topFolder) {return false;}
  return !sharedFolder(options, pair.fromModule.topFolder) &&
    !sharedFolder(options, pair.toModule.topFolder);
}

function bothModulesHaveLayers(
  graph: ProjectArchitectureGraph,
  pair: ModulePair,
): boolean {
  return moduleLayer(graph, pair.fromModule) !== null &&
    moduleLayer(graph, pair.toModule) !== null;
}

function moduleLayer(
  graph: ProjectArchitectureGraph,
  module: SourceModule,
): number | null {
  return graph.folderLayerIndex.get(module.folder) ?? null;
}

function crossDomainSiblingDiagnostic(
  pair: ModulePair,
): ArchitectureDiagnostic {
  return {
    ruleId: "no-cross-domain-sibling-import",
    file: pair.fromModule.fileName,
    severity: "warn",
    message:
      `${pair.fromModule.relativePath} imports ${pair.toModule.relativePath} across sibling ` +
      `domains (${pair.fromModule.topFolder} -> ${pair.toModule.topFolder}). ` +
      "Sibling features should meet through a facade, registry, or shared kernel.",
  };
}

function crossLayerDiagnostic(
  pair: ModulePair,
  options: ResolvedArchitectureOptions,
  fromLayer: number,
  toLayer: number,
): ArchitectureDiagnostic {
  const fromLayerName = options.layers[fromLayer]?.name ?? `layer ${fromLayer}`;
  const toLayerName = options.layers[toLayer]?.name ?? `layer ${toLayer}`;
  return {
    ruleId: "no-upward-layer-import",
    file: pair.fromModule.fileName,
    severity: "warn",
    message:
      `${pair.fromModule.relativePath} (layer '${fromLayerName}') imports upward into ` +
      `${pair.toModule.relativePath} (layer '${toLayerName}'). ` +
      "Lower-numbered layers must not depend on higher-numbered ones; move the shared " +
      "contract into a deeper layer or invert the dependency.",
  };
}

function sharedFolder(
  options: ResolvedArchitectureOptions,
  folderName: string,
): boolean {
  return options.sharedFolderNames.some((entry) => entry.folder === folderName);
}
