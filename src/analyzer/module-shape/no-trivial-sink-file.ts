/**
 * @file Detection of trivial sink files: a near-empty module with one or two
 * exports that exactly one file actually uses, where the extra hop buys the
 * reader nothing. Barrels and files whose only consumers re-export them are
 * exempt, since indirection is the whole point of those.
 */

import type {
  ExportConsumer,
  ProjectArchitectureGraph,
  SourceModule,
} from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import {
  explicitFacadeModule,
  generatedModule,
} from "../project/index.js";

const MAX_EXPORTED_SYMBOLS = 2;
const MAX_TOP_LEVEL_STATEMENTS = 5;

/**
 * Report modules whose whole surface could move to their single call site:
 * one or two exports, at most five top-level statements, and exactly one
 * consuming file that imports the symbols rather than re-exporting them.
 * @param graph Supplies the module list and the consumer records that say
 * who reaches each export and whether they use or forward it.
 * @param options Facade allowlist; a listed file keeps its indirection.
 * @returns One warning per removable sink file, naming its lone consumer;
 * empty when no file is both trivial and single-consumer.
 */
export function trivialSinkFileDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.modules.flatMap((module) =>
    trivialSinkFileDiagnostic(graph, options, module)
  );
}

function trivialSinkFileDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  module: SourceModule,
): readonly ArchitectureDiagnostic[] {
  if (!sinkCandidate(module, options)) {return [];}
  if (!moduleHasTrivialSurface(module)) {return [];}
  const consumers = graph.exportConsumersByFileName.get(module.fileName) ?? [];
  const uniqueConsumerFile = soleConsumerFile(consumers);
  if (uniqueConsumerFile === null) {return [];}
  if (consumersOnlyReexport(consumers)) {return [];}
  return [singleConsumerDiagnostic(module, uniqueConsumerFile, graph)];
}

function sinkCandidate(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  if (module.isTestLike) {return false;}
  if (module.isIndex) {return false;}
  if (module.isPublic) {return false;}
  if (generatedModule(module)) {return false;}
  if (explicitFacadeModule(module, options)) {return false;}
  return true;
}

function moduleHasTrivialSurface(module: SourceModule): boolean {
  if (module.exportedSymbolCount === 0) {return false;}
  if (module.exportedSymbolCount > MAX_EXPORTED_SYMBOLS) {return false;}
  if (module.topLevelStatementCount > MAX_TOP_LEVEL_STATEMENTS) {return false;}
  return !isPureBarrel(module);
}

function isPureBarrel(module: SourceModule): boolean {
  if (module.exportedSymbolCount === 0) {return false;}
  return (
    module.localReexportCount + module.starExportCount === module.exportedSymbolCount
  );
}

function soleConsumerFile(consumers: readonly ExportConsumer[]): string | null {
  if (consumers.length === 0) {return null;}
  const unique = new Set(consumers.map((consumer) => consumer.consumerFile));
  if (unique.size !== 1) {return null;}
  const [first] = unique;
  return first ?? null;
}

function consumersOnlyReexport(consumers: readonly ExportConsumer[]): boolean {
  if (consumers.length === 0) {return false;}
  return consumers.every((consumer) => consumer.kind === "reexport");
}

function singleConsumerDiagnostic(
  module: SourceModule,
  consumerFile: string,
  graph: ProjectArchitectureGraph,
): ArchitectureDiagnostic {
  const consumerModule = graph.modulesByFileName.get(consumerFile);
  const consumerLabel = consumerModule?.relativePath ?? consumerFile;
  return {
    ruleId: "no-trivial-sink-file",
    file: module.fileName,
    severity: "warn",
    message:
      `${module.relativePath} has 1 consumer (${consumerLabel}) and a trivial surface ` +
      `(${module.exportedSymbolCount} export${module.exportedSymbolCount === 1 ? "" : "s"}, ` +
      `${module.topLevelStatementCount} top-level statement${module.topLevelStatementCount === 1 ? "" : "s"}). ` +
      `Inline its contents at the call site to remove the indirection, or expose it via a barrel if it is meant to be public.`,
  };
}
