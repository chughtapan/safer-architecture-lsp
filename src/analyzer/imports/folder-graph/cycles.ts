/**
 * @file Folder-cycle detection and its two diagnostics. Cycles are found once
 * as strongly connected components and then read twice: any cycle at all is a
 * warning, and a cycle that specifically joins the root files to `internal`
 * is an error, because that is the one boundary the package promises to keep.
 */

import type { ArchitectureDiagnostic } from "../../project/api/index.js";
import type { FolderEdge, ProjectArchitectureGraph } from "../project-graph/index.js";
import {
  cyclicStronglyConnectedComponents,
  makeDirectedGraph,
} from "../../graph/index.js";

/**
 * Find the folder groups that depend on each other in a loop. Folders are
 * taken from the edge endpoints, so a folder with no dependencies at all
 * cannot appear in the result.
 * @param folderEdges Collapsed folder-to-folder dependencies.
 * @returns The components with a genuine cycle; single folders without a self-edge are excluded.
 */
export function stronglyConnectedFolderComponents(
  folderEdges: readonly FolderEdge[],
): ReadonlyArray<readonly string[]> {
  const nodes = folderEdges.flatMap((edge) => [edge.from, edge.to]);
  return cyclicStronglyConnectedComponents(makeDirectedGraph(nodes, folderEdges));
}

/**
 * Turn each cyclic folder component into one warning naming its members.
 * The whole component is reported once rather than per edge, since every edge
 * in a cycle is equally implicated.
 * @param graph Supplies the file a folder-level finding is attributed to.
 * @param components Cyclic folder groups from `stronglyConnectedFolderComponents`.
 * @returns One warning per cyclic component.
 */
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

/**
 * Report the specific case of root files and `internal` depending on each
 * other. This is an error rather than a warning because it inverts the
 * package's central promise that the root layer hides internal decisions.
 * @param graph Supplies the file a folder-level finding is attributed to.
 * @param components Cyclic folder groups from `stronglyConnectedFolderComponents`.
 * @returns A single error when any component joins the root folder to `internal`, otherwise nothing.
 */
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
