/**
 * @file Folder-graph analysis barrel. Composes the four folder-graph
 * checks (cycles, mesh, cross-domain-sibling, cross-layer, distance)
 * into one diagnostic pass.
 */

import { distantFolderImportDiagnostics } from "../folder-distance.js";
import {
  folderCycleDiagnostics,
  rootInternalCycleDiagnostics,
  stronglyConnectedFolderComponents,
} from "./cycles.js";
import { packageMeshDiagnostics, productionFolderGraph } from "./mesh.js";
import {
  crossDomainSiblingImportDiagnostics,
  crossLayerImportDiagnostics,
} from "./cross-folder.js";
import type { ProjectArchitectureGraph } from "../project-graph/index.js";
import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../../project/api/index.js";

/**
 * Run every folder-graph architecture check against the project graph
 * and return their combined diagnostic list. Composes the cycle,
 * mesh-density, distant-import, cross-domain-sibling, and cross-layer
 * checks into a single pass.
 * @param graph Project architecture graph (modules, folders, edges).
 * @param options Resolved architecture rule options with policy lists.
 * @returns Combined diagnostics from every folder-graph check.
 */
export function checkFolderGraph(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const productionGraph = productionFolderGraph(graph);
  const components = stronglyConnectedFolderComponents(productionGraph.edges);
  return [
    ...folderCycleDiagnostics(graph, components),
    ...rootInternalCycleDiagnostics(graph, components),
    ...packageMeshDiagnostics(graph, productionGraph, components, options),
    ...distantFolderImportDiagnostics(graph, options),
    ...crossDomainSiblingImportDiagnostics(graph, options),
    ...crossLayerImportDiagnostics(graph, options),
  ];
}
