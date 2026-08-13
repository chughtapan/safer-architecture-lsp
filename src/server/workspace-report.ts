/**
 * @file Whole-workspace analysis. Runs the project analyzer once per
 * listed workspace package, each under its own config, and merges those
 * findings with the cross-package cycles no single project can see. An
 * invalid manifest or package config fails the run instead of reporting
 * partial coverage as clean.
 */

import path from "node:path";
import {
  type ArchitectureAnalysisSnapshot,
  type ArchitectureDiagnostic,
  type ArchitectureReport,
  type ArchitectureWaiver,
  resolveArchitectureOptions,
  uniqueDiagnostics,
} from "../analyzer/project/api/index.js";
import { getOrCreateWorkspaceCache } from "../analyzer/project/cache/index.js";
import {
  type DiscoveredWorkspace,
  discoverWorkspace,
  workspacePackageCycleDiagnostics,
  type WorkspaceProject,
} from "../analyzer/workspace/index.js";
import { type LoadedWorkspaceConfig, loadWorkspaceConfig } from "./config-loader.js";

interface WorkspaceProjectReport {
  readonly name: string;
  readonly root: string;
  readonly configSource: LoadedWorkspaceConfig["source"];
  readonly report: ArchitectureReport;
}

/**
 * Everything one workspace analysis produced: the per-package reports
 * alongside the deduplicated findings, waivers, and snapshots pooled
 * across them, with the findings pre-indexed by file for lookup.
 */
export interface WorkspaceArchitectureReport {
  readonly root: string;
  readonly manifestPath: string | null;
  readonly projects: readonly WorkspaceProjectReport[];
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly diagnosticsByFile: ReadonlyMap<string, readonly ArchitectureDiagnostic[]>;
  readonly waivers: readonly ArchitectureWaiver[];
  readonly snapshots: readonly ArchitectureAnalysisSnapshot[];
}

/**
 * Either the merged report, or the first configuration problem that
 * stopped the run together with the path a caller has to fix — callers
 * must handle the failure rather than read an empty report as clean.
 */
export type WorkspaceAnalysisResult =
  | { readonly ok: true; readonly workspace: DiscoveredWorkspace; readonly report: WorkspaceArchitectureReport }
  | { readonly ok: false; readonly problem: string; readonly problemPath: string };

/**
 * Analyze either one project or every explicitly listed workspace package.
 * @param root Directory discovery starts from; a root without a workspace
 * manifest is analyzed as a single project.
 * @returns The merged report, or the first invalid manifest or package
 * config with the path that has to be fixed.
 */
export function analyzeWorkspaceRoot(root: string): WorkspaceAnalysisResult {
  const discovery = discoverWorkspace(root);
  if (!discovery.ok) {
    return { ok: false, problem: discovery.problem, problemPath: discovery.manifestPath };
  }

  const projectReports: WorkspaceProjectReport[] = [];
  for (const project of discovery.workspace.projects) {
    const result = analyzeProject(project);
    if (!result.ok) {return result;}
    projectReports.push(result.projectReport);
  }

  const diagnostics = uniqueDiagnostics([
    ...workspacePackageCycleDiagnostics(discovery.workspace),
    ...projectReports.flatMap(({ report }) => report.diagnostics),
  ]);
  const waivers = projectReports.flatMap(({ report }) => report.waivers);
  return {
    ok: true,
    workspace: discovery.workspace,
    report: {
      root: discovery.workspace.workspaceRoot,
      manifestPath: discovery.workspace.manifestPath,
      projects: projectReports,
      diagnostics,
      diagnosticsByFile: indexByFile(diagnostics),
      waivers,
      snapshots: projectReports.map(({ report }) => report.snapshot),
    },
  };
}

function analyzeProject(project: WorkspaceProject):
  | { readonly ok: true; readonly projectReport: WorkspaceProjectReport }
  | { readonly ok: false; readonly problem: string; readonly problemPath: string } {
  const config = loadWorkspaceConfig(project.root);
  if (config.problem !== null) {
    return {
      ok: false,
      problem: `${path.basename(config.configPath)} at ${project.root} is invalid: ${config.problem}`,
      problemPath: config.configPath,
    };
  }
  const options = resolveArchitectureOptions({ ...config.options, projectRoot: project.root });
  return {
    ok: true,
    projectReport: {
      name: project.name,
      root: project.root,
      configSource: config.source,
      report: getOrCreateWorkspaceCache(project.root).get(options),
    },
  };
}

function indexByFile(
  diagnostics: readonly ArchitectureDiagnostic[],
): ReadonlyMap<string, readonly ArchitectureDiagnostic[]> {
  const result = new Map<string, ArchitectureDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const current = result.get(diagnostic.file);
    if (current === undefined) {result.set(diagnostic.file, [diagnostic]);}
    else {current.push(diagnostic);}
  }
  return result;
}
