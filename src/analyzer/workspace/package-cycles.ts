/**
 * @file Cross-package cycle detection for a workspace. Only dependencies naming
 * another package of the same workspace become edges, so third-party packages
 * can never appear in a cycle, and each cycle is reported once against the
 * package.json of whichever member sorts first.
 */

import type { ArchitectureDiagnostic } from "../project/diagnostics/index.js";
import type { DiscoveredWorkspace, WorkspaceProject } from "./manifest.js";
import { makeDirectedGraph } from "../graph/directed-graph.js";
import {
  canonicalCyclePath,
  cyclicStronglyConnectedComponents,
} from "../graph/strongly-connected-components.js";

interface PackageEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * Report one diagnostic per group of workspace packages that depend on each
 * other at runtime, directly or through other members of the group. A root with
 * no manifest is a single package and can hold no cross-package cycle.
 * @param workspace Packages whose runtime dependencies are matched against each
 * other by package name; dependencies on non-members are ignored.
 * @returns One diagnostic per cycle, naming the members and a canonical path
 * through them so repeated runs report the same cycle the same way.
 */
export function workspacePackageCycleDiagnostics(
  workspace: DiscoveredWorkspace,
): readonly ArchitectureDiagnostic[] {
  if (workspace.manifestPath === null) {return [];}
  const byName = new Map(workspace.projects.map((project) => [project.name, project] as const));
  const edges: PackageEdge[] = [];
  for (const project of workspace.projects) {
    for (const dependency of project.runtimeDependencies) {
      if (byName.has(dependency)) {edges.push({ from: project.name, to: dependency });}
    }
  }
  const graph = makeDirectedGraph([...byName.keys()], edges);
  return cyclicStronglyConnectedComponents(graph).map((component) => {
    const cycle = canonicalCyclePath(graph, component);
    const anchor =
      // Every graph node comes from `byName` and a cycle component is a
      // non-empty subset of those nodes, so the lookup is known to hit.
      byName.get(component[0]) as WorkspaceProject;
    return {
      ruleId: "no-workspace-package-cycle",
      file: anchor.packageJsonPath,
      severity: "error",
      message: `Workspace package dependency cycle: ${component.join(" <-> ")}. Canonical cycle: ${cycle.join(" -> ")}. Runtime package dependencies must form a directed acyclic graph.`,
    };
  });
}
