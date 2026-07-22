/**
 * @file Module-shape analysis barrel. Composes the per-rule module
 * checks (implicit boundary, shared-kernel cohesion, trivial sink
 * file, fat orchestrator) into a single project-level diagnostic pass.
 */

import { fatOrchestratorDiagnostics } from "./no-fat-orchestrator.js";
import { implicitBoundaryModuleDiagnostics } from "./implicit-boundary.js";
import { sharedKernelCohesionDiagnostics } from "./shared-kernel-cohesion.js";
import { trivialSinkFileDiagnostics } from "./no-trivial-sink-file.js";
import { uniqueDiagnostics } from "../project/api/index.js";
import type { ProjectArchitectureGraph } from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";

/**
 * Run every module-shape architecture check (implicit boundary,
 * shared-kernel cohesion, trivial sink file, fat orchestrator) against
 * the project graph and return a deduplicated diagnostic list.
 * @param graph Project architecture graph (modules, folders, edges).
 * @param options Resolved architecture rule options with policy lists.
 * @returns Deduplicated diagnostics; empty array when the module layer
 * is healthy.
 */
export function checkModuleShape(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return uniqueDiagnostics([
    ...implicitBoundaryModuleDiagnostics(graph, options),
    ...sharedKernelCohesionDiagnostics(graph, options),
    ...trivialSinkFileDiagnostics(graph, options),
    ...fatOrchestratorDiagnostics(graph, options),
  ]);
}
