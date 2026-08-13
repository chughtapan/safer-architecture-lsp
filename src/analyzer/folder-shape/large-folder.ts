/**
 * @file Folder child-count budget. Measures each folder's direct children
 * against three independent limits - production children, children including
 * tests, and test children with no production counterpart - with per-folder
 * overrides taking precedence over the project-wide defaults.
 */

import type { ProjectArchitectureGraph } from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import {
  firstSorted,
  folderChildren,
  type FolderChildren,
  sourceFolderPath,
} from "./children/index.js";

interface FolderSizeStats {
  readonly productionChildren: readonly string[];
  readonly testChildren: readonly string[];
  readonly unpairedTestChildren: readonly string[];
  readonly visibleChildren: readonly string[];
  readonly totalChildrenIncludingTests: number;
  readonly maxProductionChildren: number;
  readonly maxChildrenIncludingTests: number;
  readonly maxUnpairedTestChildren: number;
}

/**
 * Warn about every folder that exceeds any one of its three child-count
 * limits. Unpaired tests are counted separately so that tests sitting beside
 * the code they exercise do not, on their own, push a folder over budget.
 * @param graph Modules and folders whose direct children are counted.
 * @param options Project-wide child limits and the per-folder overrides that
 * replace them.
 * @returns One warning per over-budget folder, naming its alphabetically
 * first six children as evidence; empty when every folder fits.
 */
export function folderChildLimitDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return folderChildren(graph, options).flatMap((children) =>
    folderChildLimitDiagnostic(children, graph, options)
  );
}

function folderChildLimitDiagnostic(
  children: FolderChildren,
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const stats = folderSizeStats(children, options);
  if (!largeFolder(stats)) {return [];}
  return [largeFolderDiagnostic(children, graph, stats)];
}

function folderSizeStats(
  children: FolderChildren,
  options: ResolvedArchitectureOptions,
): FolderSizeStats {
  const unpairedTestChildren = setDifference(children.testChildren, children.productionChildren);
  const productionChildren = [...children.productionChildren].sort();
  const testChildren = [...children.testChildren].sort();
  return {
    productionChildren,
    testChildren,
    unpairedTestChildren,
    visibleChildren: unionSorted(productionChildren, testChildren),
    totalChildrenIncludingTests: productionChildren.length + testChildren.length,
    maxProductionChildren: maxChildrenForFolder(children.folder, options),
    maxChildrenIncludingTests: maxChildrenIncludingTestsForFolder(children.folder, options),
    maxUnpairedTestChildren: maxUnpairedTestChildrenForFolder(children.folder, options),
  };
}

function largeFolder(stats: FolderSizeStats): boolean {
  return stats.productionChildren.length > stats.maxProductionChildren ||
    stats.totalChildrenIncludingTests > stats.maxChildrenIncludingTests ||
    stats.unpairedTestChildren.length > stats.maxUnpairedTestChildren;
}

function maxChildrenForFolder(
  folder: string,
  options: ResolvedArchitectureOptions,
): number {
  return folderChildLimitOverride(folder, options)?.maxChildren ?? options.maxFolderChildren;
}

function maxChildrenIncludingTestsForFolder(
  folder: string,
  options: ResolvedArchitectureOptions,
): number {
  return folderChildLimitOverride(folder, options)?.maxChildrenIncludingTests ??
    options.maxFolderChildrenIncludingTests;
}

function maxUnpairedTestChildrenForFolder(
  folder: string,
  options: ResolvedArchitectureOptions,
): number {
  return folderChildLimitOverride(folder, options)?.maxUnpairedTestChildren ??
    options.maxUnpairedTestChildren;
}

function folderChildLimitOverride(
  folder: string,
  options: ResolvedArchitectureOptions,
): ResolvedArchitectureOptions["folderChildCountOverrides"][number] | undefined {
  return options.folderChildCountOverrides.find((entry) => entry.folder === folder);
}

function largeFolderDiagnostic(
  children: FolderChildren,
  graph: ProjectArchitectureGraph,
  stats: FolderSizeStats,
): ArchitectureDiagnostic {
  const file = firstSorted(children.files) ?? graph.reportFile;
  return {
    ruleId: "no-large-folder",
    file,
    severity: "warn",
    message:
      `${sourceFolderPath(children.folder)} has ${stats.productionChildren.length} ` +
      `direct production children (max ${stats.maxProductionChildren}), ` +
      `${stats.totalChildrenIncludingTests} children including tests (max ` +
      `${stats.maxChildrenIncludingTests}), and ${stats.unpairedTestChildren.length} ` +
      `unpaired test children (max ${stats.maxUnpairedTestChildren}): ` +
      `${stats.visibleChildren.slice(0, 6).join(", ")}. ` +
      "Split broad package-tree folders into semantic subfolders or pair tests with the code they exercise.",
  };
}

function setDifference(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): readonly string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function unionSorted(
  leftValues: readonly string[],
  rightValues: readonly string[],
): readonly string[] {
  return [...new Set([...leftValues, ...rightValues])].sort();
}
