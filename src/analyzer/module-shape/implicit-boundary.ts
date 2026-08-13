/**
 * @file Detection of undeclared boundary modules: files that sit between a
 * band of production callers and a band of implementation files without
 * being an index or a listed facade. Traffic shape, not naming, decides —
 * a file the project already treats as an API is one whether or not anyone
 * said so.
 */

import type { ProjectArchitectureGraph, SourceModule } from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import {
  explicitFacadeModule,
  generatedModule,
  resolveImplementationModule,
  resolveProductionModule,
} from "../project/index.js";

/**
 * Report every module carrying boundary-shaped traffic that has not been
 * declared a boundary: enough exported names, enough production files
 * depending on it, and enough implementation files it depends on.
 * @param graph Supplies the module list and the incoming edges, which a
 * module's own record does not carry.
 * @param options Thresholds for how much traffic counts as a boundary, plus
 * the facade allowlist that exempts deliberate non-index APIs.
 * @returns One warning per undeclared boundary module; empty when every
 * boundary in the project is an index or a listed facade.
 */
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
  if (!implicitBoundaryCandidate(module, options)) {return [];}
  const incomingFiles = incomingProductionFiles(graph, module);
  const outgoingFiles = outgoingImplementationFiles(graph, module);
  if (!implicitBoundaryShape(incomingFiles, outgoingFiles, options)) {return [];}
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
