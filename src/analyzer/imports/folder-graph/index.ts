/**
 * @file Folder-graph analysis barrel. Composes the four folder-graph
 * checks (cycles, mesh, cross-domain-sibling, cross-layer, distance)
 * into one diagnostic pass.
 */

import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../../project/api/index.js";
import type { ProjectArchitectureGraph } from "../project-graph/index.js";
import { distantFolderImportDiagnostics } from "../folder-distance.js";
import {
  crossDomainSiblingImportDiagnostics,
  crossLayerImportDiagnostics,
} from "./cross-folder.js";
import {
  folderCycleDiagnostics,
  rootInternalCycleDiagnostics,
  stronglyConnectedFolderComponents,
} from "./cycles.js";
import { packageMeshDiagnostics, productionFolderGraph } from "./mesh.js";

/**
 * Run every folder-graph architecture check against the project graph
 * and return their combined diagnostic list. Composes the cycle,
 * mesh-density, distant-import, cross-domain-sibling, and cross-layer
 * checks into a single pass. Folder cycles and the mesh cycle count are
 * read from the edges a composition root is not solely responsible for;
 * the root/internal check reads every production edge, because the root
 * entry it guards is usually a composition root itself.
 * @param graph Project architecture graph (modules, folders, edges).
 * @param options Resolved architecture rule options with policy lists.
 * @returns Combined diagnostics from every folder-graph check.
 */
export function checkFolderGraph(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const productionGraph = productionFolderGraph(graph, options);
  const layeringComponents = stronglyConnectedFolderComponents(productionGraph.layeringEdges);
  return [
    ...folderCycleDiagnostics(graph, layeringComponents),
    ...rootInternalCycleDiagnostics(
      graph,
      stronglyConnectedFolderComponents(productionGraph.edges),
    ),
    ...packageMeshDiagnostics(graph, productionGraph, layeringComponents, options),
    ...distantFolderImportDiagnostics(graph, options),
    ...crossDomainSiblingImportDiagnostics(graph, options),
    ...crossLayerImportDiagnostics(graph, options),
  ];
}
