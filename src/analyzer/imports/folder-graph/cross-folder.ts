import type {
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "../project-graph/index.js";
import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../../project/api/index.js";

interface ModulePair {
  readonly fromModule: SourceModule;
  readonly toModule: SourceModule;
}

export function crossDomainSiblingImportDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.localEdges.flatMap((edge) =>
    crossDomainSiblingImportDiagnostic(graph, options, edge)
  );
}

export function crossLayerImportDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (options.layers.length === 0) return [];

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
  if (pair === null) return [];
  if (!isCrossDomainSiblingPair(pair, options)) return [];
  if (bothModulesHaveLayers(graph, pair)) return [];
  return [crossDomainSiblingDiagnostic(pair)];
}

function crossLayerImportDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  edge: LocalModuleEdge,
): readonly ArchitectureDiagnostic[] {
  const pair = importModulePair(graph, edge);
  if (pair === null || pair.fromModule.isTestLike) return [];
  const fromLayer = moduleLayer(graph, pair.fromModule);
  const toLayer = moduleLayer(graph, pair.toModule);
  if (fromLayer === null || toLayer === null || fromLayer <= toLayer) return [];
  return [crossLayerDiagnostic(pair, options, fromLayer, toLayer)];
}

function importModulePair(
  graph: ProjectArchitectureGraph,
  edge: LocalModuleEdge,
): ModulePair | null {
  if (edge.kind !== "import") return null;
  const fromModule = graph.modulesByFileName.get(edge.from);
  const toModule = graph.modulesByFileName.get(edge.to);
  return fromModule && toModule ? { fromModule, toModule } : null;
}

function isCrossDomainSiblingPair(
  pair: ModulePair,
  options: ResolvedArchitectureOptions,
): boolean {
  if (pair.fromModule.isTestLike || pair.toModule.isTestLike) return false;
  if (pair.fromModule.topFolder === "." || pair.toModule.topFolder === ".") return false;
  if (pair.fromModule.topFolder === pair.toModule.topFolder) return false;
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
