import type { ArchitectureDiagnostic } from "../../project/api/index.js";
import type { FolderEdge, ProjectArchitectureGraph } from "../project-graph/index.js";
import {
  cyclicStronglyConnectedComponents,
  makeDirectedGraph,
} from "../../graph/index.js";

export function stronglyConnectedFolderComponents(
  folderEdges: readonly FolderEdge[],
): ReadonlyArray<readonly string[]> {
  const nodes = folderEdges.flatMap((edge) => [edge.from, edge.to]);
  return cyclicStronglyConnectedComponents(makeDirectedGraph(nodes, folderEdges));
}

export function folderCycleDiagnostics(
  graph: ProjectArchitectureGraph,
  components: ReadonlyArray<readonly string[]>,
): readonly ArchitectureDiagnostic[] {
  return components.map((component) => ({
    ruleId: "no-folder-cycle",
    file: graph.reportFile,
    severity: "warn",
    message:
      `Folder dependency cycle: ${component.join(" <-> ")}. ` +
      "Folders should expose a stable direction of knowledge; cycles make every " +
      "folder in the component part of the same abstraction.",
  }));
}

export function rootInternalCycleDiagnostics(
  graph: ProjectArchitectureGraph,
  components: ReadonlyArray<readonly string[]>,
): readonly ArchitectureDiagnostic[] {
  const hasCycle = components.some(
    (component) => component.includes(".") && component.includes("internal"),
  );
  if (!hasCycle) {return [];}

  return [
    {
      ruleId: "no-root-internal-cycle",
      file: graph.reportFile,
      severity: "error",
      message:
        "Root files and internal files depend on each other. The public/root layer " +
        "should hide internal decisions; internal code should not import back through it.",
    },
  ];
}
