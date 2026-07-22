import path from "node:path";
import {
  explicitFacadeModule,
  generatedModule,
} from "../project/index.js";
import type {
  LocalModuleEdge,
  ProjectArchitectureGraph,
  SourceModule,
} from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";

interface FolderApiEvidence {
  readonly folder: string;
  readonly consumerFiles: ReadonlySet<string>;
  readonly concreteTargetFiles: ReadonlySet<string>;
  readonly facadeConsumerFiles: ReadonlySet<string>;
}

interface MutableFolderApiEvidence {
  readonly folder: string;
  readonly consumerFiles: Set<string>;
  readonly concreteTargetFiles: Set<string>;
  readonly facadeConsumerFiles: Set<string>;
}

interface ModulePair {
  readonly fromModule: SourceModule;
  readonly toModule: SourceModule;
}

export function explicitFolderApiDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return folderApiEvidence(graph, options).flatMap((evidence) =>
    explicitFolderApiDiagnostic(evidence, graph, options)
  );
}

function folderApiEvidence(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly FolderApiEvidence[] {
  const evidenceByFolder = new Map<string, MutableFolderApiEvidence>();
  for (const edge of graph.localEdges) {
    addFolderApiEdgeEvidence(evidenceByFolder, graph, options, edge);
  }
  addFacadeConsumerEvidence(evidenceByFolder, graph, options);
  return [...evidenceByFolder.values()].sort(compareFolderEvidence);
}

function addFolderApiEdgeEvidence(
  evidenceByFolder: Map<string, MutableFolderApiEvidence>,
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  edge: LocalModuleEdge,
): void {
  if (edge.kind !== "import") return;
  const pair = modulePair(graph, edge);
  if (pair === null || !concreteFolderApiTarget(pair.toModule, options)) return;
  for (const folder of candidateApiFolders(pair.toModule.folder)) {
    addFolderApiCandidate(evidenceByFolder, options, pair, folder);
  }
}

function addFolderApiCandidate(
  evidenceByFolder: Map<string, MutableFolderApiEvidence>,
  options: ResolvedArchitectureOptions,
  pair: ModulePair,
  folder: string,
): void {
  if (ignoredFolderApiCandidate(pair, folder, options)) return;
  const evidence = mutableFolderApiEvidence(evidenceByFolder, folder);
  evidence.consumerFiles.add(pair.fromModule.fileName);
  evidence.concreteTargetFiles.add(pair.toModule.fileName);
}

function mutableFolderApiEvidence(
  evidenceByFolder: Map<string, MutableFolderApiEvidence>,
  folder: string,
): MutableFolderApiEvidence {
  const existing = evidenceByFolder.get(folder);
  if (existing) return existing;
  const evidence = {
    folder,
    concreteTargetFiles: new Set<string>(),
    consumerFiles: new Set<string>(),
    facadeConsumerFiles: new Set<string>(),
  };
  evidenceByFolder.set(folder, evidence);
  return evidence;
}

function addFacadeConsumerEvidence(
  evidenceByFolder: ReadonlyMap<string, MutableFolderApiEvidence>,
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): void {
  for (const edge of graph.localEdges) {
    const pair = modulePair(graph, edge);
    if (pair !== null) addFacadeConsumerPairEvidence(evidenceByFolder, pair, options);
  }
}

function addFacadeConsumerPairEvidence(
  evidenceByFolder: ReadonlyMap<string, MutableFolderApiEvidence>,
  pair: ModulePair,
  options: ResolvedArchitectureOptions,
): void {
  const evidence = evidenceByFolder.get(pair.toModule.folder);
  if (!evidence || !explicitFacadeModule(pair.toModule, options)) return;
  if (!outsideFolder(pair.fromModule, pair.toModule.folder)) return;
  evidence.facadeConsumerFiles.add(pair.fromModule.fileName);
}

function explicitFolderApiDiagnostic(
  evidence: FolderApiEvidence,
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (evidence.concreteTargetFiles.size < options.minExplicitApiConcreteFiles) return [];
  if (hasDominantFacadeConsumers(evidence)) return [];
  const file = firstSorted(evidence.concreteTargetFiles) ?? graph.reportFile;
  return [folderApiDiagnostic(file, evidence, graph.projectRoot)];
}

function folderApiDiagnostic(
  file: string,
  evidence: FolderApiEvidence,
  projectRoot: string,
): ArchitectureDiagnostic {
  const folderPath = sourceFolderPath(evidence.folder);
  return {
    ruleId: "folder-explicit-api-required",
    file,
    severity: "warn",
    message:
      `${folderPath} is being consumed as a folder API through ` +
      `${evidence.concreteTargetFiles.size} concrete files. Add ` +
      `${folderPath}/index.ts, or list a deliberate non-index facade in ` +
      `architecture facadeFiles and make outside code import it. Project root: ` +
      `${path.basename(projectRoot)}.`,
  };
}

const DOMINANT_FACADE_RATIO = 0.8;

function hasDominantFacadeConsumers(evidence: FolderApiEvidence): boolean {
  if (evidence.consumerFiles.size === 0) return false;
  const overlap = setIntersectionSize(evidence.consumerFiles, evidence.facadeConsumerFiles);
  return overlap / evidence.consumerFiles.size >= DOMINANT_FACADE_RATIO;
}

function concreteFolderApiTarget(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  return !explicitFacadeModule(module, options) &&
    !module.isTestLike &&
    !generatedModule(module);
}

function ignoredFolderApiCandidate(
  pair: ModulePair,
  folder: string,
  options: ResolvedArchitectureOptions,
): boolean {
  return !outsideFolder(pair.fromModule, folder) ||
    sharedFolder(options, folder) ||
    pair.fromModule.isTestLike ||
    generatedModule(pair.fromModule);
}

function compareFolderEvidence(
  left: FolderApiEvidence,
  right: FolderApiEvidence,
): number {
  return left.folder.localeCompare(right.folder);
}

function modulePair(
  graph: ProjectArchitectureGraph,
  edge: LocalModuleEdge,
): ModulePair | null {
  const fromModule = graph.modulesByFileName.get(edge.from);
  const toModule = graph.modulesByFileName.get(edge.to);
  return fromModule && toModule ? { fromModule, toModule } : null;
}

function candidateApiFolders(folder: string): readonly string[] {
  if (folder === ".") return [];
  const segments = folder.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function outsideFolder(module: SourceModule, folder: string): boolean {
  return !folderContains(folder, module.folder);
}

function folderContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function sharedFolder(
  options: ResolvedArchitectureOptions,
  folder: string,
): boolean {
  return options.sharedFolderNames.some((entry) => folderContains(entry.folder, folder));
}

function firstSorted(values: ReadonlySet<string>): string | null {
  return [...values].sort()[0] ?? null;
}

function sourceFolderPath(folder: string): string {
  return folder === "." ? "src" : `src/${folder}`;
}

function setIntersectionSize<T>(
  left: ReadonlySet<T>,
  right: ReadonlySet<T>,
): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}
