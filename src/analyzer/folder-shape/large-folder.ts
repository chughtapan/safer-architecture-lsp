import {
  firstSorted,
  folderChildren,
  sourceFolderPath,
  type FolderChildren,
} from "./children/index.js";
import type { ProjectArchitectureGraph } from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";

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
  if (!largeFolder(stats)) return [];
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
