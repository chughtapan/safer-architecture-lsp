// safer-arch-ignore no-trivial-sink-file: module SCC policy stays isolated from graph construction so the typed graph primitive remains reusable for domains and packages.
import path from "node:path";
import {
  canonicalCyclePath,
  cyclicStronglyConnectedComponents,
  makeDirectedGraph,
} from "../graph/index.js";
import type { ArchitectureDiagnostic } from "../project/api/index.js";
import type { ProjectArchitectureGraph } from "../project/index.js";

/** Report one stable diagnostic for each production module SCC. */
export function moduleCycleDiagnostics(
  graph: ProjectArchitectureGraph,
): readonly ArchitectureDiagnostic[] {
  const productionModules = graph.modules.filter((module) => !module.isTestLike);
  const productionFiles = new Set(productionModules.map((module) => module.fileName));
  const productionEdges = graph.localEdges.filter(
    (edge) => productionFiles.has(edge.from) && productionFiles.has(edge.to),
  );
  const moduleGraph = makeDirectedGraph(
    productionModules.map((module) => module.fileName),
    productionEdges,
  );

  return cyclicStronglyConnectedComponents(moduleGraph).map((component) => {
    const cycle = canonicalCyclePath(moduleGraph, component);
    const relativeComponent = component.map((fileName) => relativeFile(graph, fileName));
    const relativeCycle = cycle.map((fileName) => relativeFile(graph, fileName));
    return {
      ruleId: "no-module-cycle",
      file: component[0] ?? graph.reportFile,
      severity: "warn",
      message:
        `Module dependency component (${component.length}): ${relativeComponent.join(", ")}. ` +
        `Canonical cycle: ${relativeCycle.join(" -> ")}. Break the cycle by moving ` +
        "shared contracts inward or reversing one dependency.",
    };
  });
}

function relativeFile(graph: ProjectArchitectureGraph, fileName: string): string {
  return path.relative(graph.projectRoot, fileName).replaceAll("\\", "/");
}
