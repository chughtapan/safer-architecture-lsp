/**
 * @file The `no-package-mesh` check. It judges the folder graph as a whole
 * rather than any single edge: too many distinct folder-to-folder directions
 * for the folder count, or too many cycle groups, means the package is wired
 * as a mesh instead of layered. Test-like modules are filtered out first so
 * test wiring cannot make production structure look worse than it is.
 */

import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../../project/api/index.js";
import type {
  FolderEdge,
  ProjectArchitectureGraph,
} from "../project-graph/index.js";

/**
 * The folder graph with test-only modules and test-only edges removed, which
 * is the shape the mesh thresholds are measured against.
 */
export interface ProductionFolderGraph {
  readonly folders: readonly string[];
  readonly edges: readonly FolderEdge[];
}

/**
 * Narrow the project graph to production folders and the edges at least one
 * production file is responsible for.
 * @param graph Full project graph, including test-like modules.
 * @returns The production-only folder set and edge list used by the mesh thresholds.
 */
export function productionFolderGraph(
  graph: ProjectArchitectureGraph,
): ProductionFolderGraph {
  return {
    folders: productionFolderNames(graph),
    edges: productionFolderEdges(graph),
  };
}

function folderEdgeDensity(
  folders: readonly string[],
  folderEdges: readonly FolderEdge[],
): number {
  if (folders.length < 2) {return 0;}

  const uniqueDirections = new Set(
    folderEdges.map((edge) => `${edge.from}\0${edge.to}`),
  );
  return uniqueDirections.size / (folders.length * (folders.length - 1));
}

/**
 * Warn once when the production folder graph is too densely or too cyclically
 * connected to read as layered. Small projects are skipped entirely, since
 * density is meaningless below the configured folder count.
 * @param graph Supplies the file this whole-graph finding is attributed to.
 * @param productionGraph Production folders and edges the density is computed over.
 * @param components Cyclic folder groups, counted against the cycle budget.
 * @param options Carries the folder-count floor and the density and cycle budgets.
 * @returns A single warning quoting the measured shape, or nothing when both budgets hold.
 */
export function packageMeshDiagnostics(
  graph: ProjectArchitectureGraph,
  productionGraph: ProductionFolderGraph,
  components: ReadonlyArray<readonly string[]>,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (productionGraph.folders.length < options.minPackageMeshFolders) {return [];}

  const density = folderEdgeDensity(productionGraph.folders, productionGraph.edges);
  const tooDense = density > options.maxFolderEdgeDensity;
  const tooCyclic = components.length > options.maxFolderCycles;
  if (!tooDense && !tooCyclic) {return [];}

  return [
    {
      ruleId: "no-package-mesh",
      file: graph.reportFile,
      severity: "warn",
      message:
        `Package folder graph has ${productionGraph.folders.length} production folders, ` +
        `${productionGraph.edges.length} production folder edges, ${components.length} cycle groups, ` +
        `and density ${density.toFixed(2)}. This is a mesh, not a layered package shape.`,
    },
  ];
}

function productionFolderEdges(graph: ProjectArchitectureGraph): readonly FolderEdge[] {
  return graph.folderEdges.filter((edge) =>
    edge.files.some((file) => productionFileEdge(graph, file))
  );
}

function productionFileEdge(
  graph: ProjectArchitectureGraph,
  fileName: string,
): boolean {
  const module = graph.modulesByFileName.get(fileName);
  return module !== undefined && !module.isTestLike;
}

function productionFolderNames(graph: ProjectArchitectureGraph): readonly string[] {
  return [...new Set(
    graph.modules
      .filter((module) => !module.isTestLike)
      .map((module) => module.folder),
  )].sort();
}
