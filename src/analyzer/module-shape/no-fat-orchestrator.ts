/**
 * @file Detection of fat orchestrators: files that wire together a large
 * slice of the project yet almost nobody imports. Entry points are supposed
 * to look like this, so anything under bin/ or cli/, any index/main/cli or
 * config file, and any public module is exempt — the complaint is about
 * wiring hidden in the middle of the tree, not wiring as such.
 */

import type {
  ProjectArchitectureGraph,
  SourceModule,
} from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import {
  generatedModule,
} from "../project/index.js";

const MIN_FAN_OUT = 15;
const MIN_TOP_LEVEL_STATEMENTS = 20;
const MAX_FAN_IN = 1;

const ENTRY_PATH_PATTERNS = [
  /(^|[\\/])bin[\\/]/,
  /(^|[\\/])cli[\\/]/,
  /(^|[\\/])(main|cli|index)\.[cm]?[jt]sx?$/,
  /\.config\.[cm]?[jt]sx?$/,
];

/**
 * Report non-entry modules shaped like wiring: at least 15 imports, at least
 * 20 top-level statements, and at most one distinct consumer.
 * @param graph Supplies the module list and each module's consumers, which a
 * module's own record does not carry.
 * @param _options Unused; the thresholds here are fixed constants. The
 * parameter keeps the signature interchangeable with the other module-shape
 * checks the barrel calls.
 * @returns One warning per fat orchestrator; empty when every wiring-shaped
 * file is reachable as an entry point.
 */
export function fatOrchestratorDiagnostics(
  graph: ProjectArchitectureGraph,
  _options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.modules.flatMap((module) => fatOrchestratorDiagnostic(graph, module));
}

function fatOrchestratorDiagnostic(
  graph: ProjectArchitectureGraph,
  module: SourceModule,
): readonly ArchitectureDiagnostic[] {
  if (!orchestratorCandidate(module)) {return [];}
  const fanOut = module.localEdges.length + module.externalEdges.length;
  if (fanOut < MIN_FAN_OUT) {return [];}
  if (module.topLevelStatementCount < MIN_TOP_LEVEL_STATEMENTS) {return [];}
  const fanIn = uniqueConsumerCount(graph, module);
  if (fanIn > MAX_FAN_IN) {return [];}
  return [fatOrchestratorReport(module, fanOut, fanIn)];
}

function orchestratorCandidate(module: SourceModule): boolean {
  if (module.isTestLike) {return false;}
  if (module.isIndex) {return false;}
  if (module.isPublic) {return false;}
  if (generatedModule(module)) {return false;}
  if (isEntryPath(module.relativePath)) {return false;}
  return true;
}

function isEntryPath(relativePath: string): boolean {
  return ENTRY_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function uniqueConsumerCount(
  graph: ProjectArchitectureGraph,
  module: SourceModule,
): number {
  const consumers = graph.exportConsumersByFileName.get(module.fileName) ?? [];
  return new Set(consumers.map((consumer) => consumer.consumerFile)).size;
}

function fatOrchestratorReport(
  module: SourceModule,
  fanOut: number,
  fanIn: number,
): ArchitectureDiagnostic {
  return {
    ruleId: "no-fat-orchestrator",
    file: module.fileName,
    severity: "warn",
    message:
      `${module.relativePath} is shaped like an orchestrator (${fanOut} imports, ` +
      `${module.topLevelStatementCount} top-level statements, ${fanIn} consumer${fanIn === 1 ? "" : "s"}) ` +
      `but is not an entry point. Either declare it as an entry point (index/main/cli, public surface, ` +
      `or move under bin/cli/) or split the wiring into focused submodules.`,
  };
}
