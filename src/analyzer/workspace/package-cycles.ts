import { makeDirectedGraph } from "../graph/directed-graph.js";
import {
  canonicalCyclePath,
  cyclicStronglyConnectedComponents,
} from "../graph/strongly-connected-components.js";
import type { ArchitectureDiagnostic } from "../project/diagnostics/index.js";
import type { DiscoveredWorkspace, WorkspaceProject } from "./manifest.js";

interface PackageEdge {
  readonly from: string;
  readonly to: string;
}

export function workspacePackageCycleDiagnostics(
  workspace: DiscoveredWorkspace,
): readonly ArchitectureDiagnostic[] {
  if (workspace.manifestPath === null) return [];
  const byName = new Map(workspace.projects.map((project) => [project.name, project] as const));
  const edges: PackageEdge[] = [];
  for (const project of workspace.projects) {
    for (const dependency of project.runtimeDependencies) {
      if (byName.has(dependency)) edges.push({ from: project.name, to: dependency });
    }
  }
  const graph = makeDirectedGraph([...byName.keys()], edges);
  return cyclicStronglyConnectedComponents(graph).map((component) => {
    const cycle = canonicalCyclePath(graph, component);
    const anchor = byName.get(component[0]) as WorkspaceProject;
    return {
      ruleId: "no-workspace-package-cycle",
      file: anchor.packageJsonPath,
      severity: "error",
      message: `Workspace package dependency cycle: ${component.join(" <-> ")}. Canonical cycle: ${cycle.join(" -> ")}. Runtime package dependencies must form a directed acyclic graph.`,
    };
  });
}
