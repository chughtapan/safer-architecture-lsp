import {
  explicitFacadeModule,
  generatedModule,
  resolveImplementationModule,
  resolveProductionModule,
} from "../project/index.js";
import type { ProjectArchitectureGraph, SourceModule } from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";

export function implicitBoundaryModuleDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.modules.flatMap((module) =>
    implicitBoundaryModuleDiagnostic(graph, options, module)
  );
}

function implicitBoundaryModuleDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  module: SourceModule,
): readonly ArchitectureDiagnostic[] {
  if (!implicitBoundaryCandidate(module, options)) return [];
  const incomingFiles = incomingProductionFiles(graph, module);
  const outgoingFiles = outgoingImplementationFiles(graph, module);
  if (!implicitBoundaryShape(incomingFiles, outgoingFiles, options)) return [];
  return [boundaryModuleDiagnostic(module, incomingFiles, outgoingFiles)];
}

function implicitBoundaryCandidate(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  if (module.isTestLike || generatedModule(module) || explicitFacadeModule(module, options)) {
    return false;
  }
  return module.exportedSymbolCount >= options.minImplicitBoundaryExports;
}

function implicitBoundaryShape(
  incomingFiles: ReadonlySet<string>,
  outgoingFiles: ReadonlySet<string>,
  options: ResolvedArchitectureOptions,
): boolean {
  return incomingFiles.size >= options.minImplicitBoundaryIncomingFiles &&
    outgoingFiles.size >= options.minImplicitBoundaryOutgoingFiles;
}

function incomingProductionFiles(
  graph: ProjectArchitectureGraph,
  module: SourceModule,
): ReadonlySet<string> {
  return new Set(
    graph.localEdges
      .filter((edge) => edge.to === module.fileName)
      .map((edge) => graph.modulesByFileName.get(edge.from))
      .filter(resolveProductionModule)
      .map((consumer) => consumer.fileName),
  );
}

function outgoingImplementationFiles(
  graph: ProjectArchitectureGraph,
  module: SourceModule,
): ReadonlySet<string> {
  return new Set(
    module.localEdges
      .map((edge) => graph.modulesByFileName.get(edge.to))
      .filter(resolveImplementationModule)
      .map((target) => target.fileName),
  );
}

function boundaryModuleDiagnostic(
  module: SourceModule,
  incomingFiles: ReadonlySet<string>,
  outgoingFiles: ReadonlySet<string>,
): ArchitectureDiagnostic {
  return {
    ruleId: "file-implicit-boundary-module",
    file: module.fileName,
    severity: "warn",
    message:
      `${module.relativePath} acts like a boundary module: ` +
      `${incomingFiles.size} production files depend on it, it depends on ` +
      `${outgoingFiles.size} implementation files, and it exports ` +
      `${module.exportedSymbolCount} names. Move the stable API to index.ts, ` +
      "or list a deliberate non-index facade in architecture facadeFiles.",
  };
}
