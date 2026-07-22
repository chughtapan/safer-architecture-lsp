import {
  explicitFacadeModule,
  generatedModule,
} from "../project/index.js";
import type {
  ExportConsumer,
  ProjectArchitectureGraph,
  SourceModule,
} from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";

const MAX_EXPORTED_SYMBOLS = 2;
const MAX_TOP_LEVEL_STATEMENTS = 5;

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
  if (!sinkCandidate(module, options)) return [];
  if (!moduleHasTrivialSurface(module)) return [];
  const consumers = graph.exportConsumersByFileName.get(module.fileName) ?? [];
  const uniqueConsumerFile = soleConsumerFile(consumers);
  if (uniqueConsumerFile === null) return [];
  if (consumersOnlyReexport(consumers)) return [];
  return [singleConsumerDiagnostic(module, uniqueConsumerFile, graph)];
}

function sinkCandidate(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  if (module.isTestLike) return false;
  if (module.isIndex) return false;
  if (module.isPublic) return false;
  if (generatedModule(module)) return false;
  if (explicitFacadeModule(module, options)) return false;
  return true;
}

function moduleHasTrivialSurface(module: SourceModule): boolean {
  if (module.exportedSymbolCount === 0) return false;
  if (module.exportedSymbolCount > MAX_EXPORTED_SYMBOLS) return false;
  if (module.topLevelStatementCount > MAX_TOP_LEVEL_STATEMENTS) return false;
  return !isPureBarrel(module);
}

function isPureBarrel(module: SourceModule): boolean {
  if (module.exportedSymbolCount === 0) return false;
  return (
    module.localReexportCount + module.starExportCount === module.exportedSymbolCount
  );
}

function soleConsumerFile(consumers: readonly ExportConsumer[]): string | null {
  if (consumers.length === 0) return null;
  const unique = new Set(consumers.map((consumer) => consumer.consumerFile));
  if (unique.size !== 1) return null;
  const [first] = unique;
  return first ?? null;
}

function consumersOnlyReexport(consumers: readonly ExportConsumer[]): boolean {
  if (consumers.length === 0) return false;
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
