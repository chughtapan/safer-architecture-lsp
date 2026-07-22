import type {
  FolderEdge,
  ProjectArchitectureGraph,
} from "../project-graph/index.js";
import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../../project/api/index.js";

export interface ProductionFolderGraph {
  readonly folders: readonly string[];
  readonly edges: readonly FolderEdge[];
}

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
  if (folders.length < 2) return 0;

  const uniqueDirections = new Set(
    folderEdges.map((edge) => `${edge.from}\0${edge.to}`),
  );
  return uniqueDirections.size / (folders.length * (folders.length - 1));
}

export function packageMeshDiagnostics(
  graph: ProjectArchitectureGraph,
  productionGraph: ProductionFolderGraph,
  components: readonly (readonly string[])[],
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (productionGraph.folders.length < options.minPackageMeshFolders) return [];

  const density = folderEdgeDensity(productionGraph.folders, productionGraph.edges);
  const tooDense = density > options.maxFolderEdgeDensity;
  const tooCyclic = components.length > options.maxFolderCycles;
  if (!tooDense && !tooCyclic) return [];

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
