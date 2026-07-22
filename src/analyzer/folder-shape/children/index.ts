/**
 * @file Folder-children analysis. Computes the direct production /
 * test child sets for every folder in the project graph; consumed by
 * folder-shape and shared-kernel cohesion checks.
 */

import path from "node:path";
import {
  explicitFacadeModule,
  generatedModule,
  type ProjectArchitectureGraph,
  type SourceModule,
} from "../../project/index.js";
import {
  stripKnownExtension,
  type ResolvedArchitectureOptions,
} from "../../project/api/index.js";

interface MutableFolderChildren {
  readonly folder: string;
  readonly productionChildren: Set<string>;
  readonly testChildren: Set<string>;
  readonly files: Set<string>;
}

/**
 * Snapshot of a folder's direct children, split by whether they are
 * production or test-like modules.
 */
export interface FolderChildren {
  /** Folder path relative to `src/`; the root folder is `.`. */
  readonly folder: string;
  /** Names of production children (subfolders + production file stems). */
  readonly productionChildren: ReadonlySet<string>;
  /** Names of test-like children (subfolders + test file stems). */
  readonly testChildren: ReadonlySet<string>;
  /** Absolute file names that contributed to this folder's child sets. */
  readonly files: ReadonlySet<string>;
}

/**
 * Compute the direct-child snapshot for every folder in the project
 * graph. Walks each module's folder ancestry so an intermediate folder
 * with no source files still appears if descendants live below it.
 * Generated modules are skipped. Explicit facade modules are not
 * counted as a direct file child of their own folder.
 * @param graph Project architecture graph (modules, folders, edges).
 * @param options Resolved architecture options used to identify
 * explicit facade modules.
 * @returns Folder-child snapshots sorted by folder path.
 */
export function folderChildren(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly FolderChildren[] {
  const byFolder = new Map<string, MutableFolderChildren>();
  for (const module of graph.modules) addModuleChildren(byFolder, module, options);
  return [...byFolder.values()].sort(compareFolderChildren);
}

function addModuleChildren(
  byFolder: Map<string, MutableFolderChildren>,
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): void {
  if (generatedModule(module)) return;
  const folderSegments = module.folder === "." ? [] : module.folder.split("/");
  addAncestorFolderChildren(byFolder, module, folderSegments);
  if (!explicitFacadeModule(module, options)) addDirectFileChild(byFolder, module);
}

function addAncestorFolderChildren(
  byFolder: Map<string, MutableFolderChildren>,
  module: SourceModule,
  folderSegments: readonly string[],
): void {
  for (let index = 0; index < folderSegments.length; index += 1) {
    const child = folderSegments[index];
    if (child !== undefined) {
      addChild(byFolder, folderFromSegments(folderSegments.slice(0, index)), child, module);
    }
  }
}

function addDirectFileChild(
  byFolder: Map<string, MutableFolderChildren>,
  module: SourceModule,
): void {
  addChild(byFolder, module.folder, fileChildName(module), module);
}

function addChild(
  byFolder: Map<string, MutableFolderChildren>,
  folder: string,
  child: string,
  module: SourceModule,
): void {
  const children = mutableFolderChildren(byFolder, folder);
  const target = module.isTestLike ? children.testChildren : children.productionChildren;
  target.add(child);
  children.files.add(module.fileName);
}

function mutableFolderChildren(
  byFolder: Map<string, MutableFolderChildren>,
  folder: string,
): MutableFolderChildren {
  const existing = byFolder.get(folder);
  if (existing) return existing;
  const children = {
    folder,
    productionChildren: new Set<string>(),
    testChildren: new Set<string>(),
    files: new Set<string>(),
  };
  byFolder.set(folder, children);
  return children;
}

function fileChildName(module: SourceModule): string {
  const fileStem = stripKnownExtension(path.basename(module.fileName));
  return module.isTestLike ? stripTestSuffix(fileStem) : fileStem;
}

function stripTestSuffix(fileStem: string): string {
  return fileStem.replace(/\.(test|spec)$/, "");
}

function folderFromSegments(segments: readonly string[]): string {
  return segments.length === 0 ? "." : segments.join("/");
}

function compareFolderChildren(
  left: FolderChildren,
  right: FolderChildren,
): number {
  return left.folder.localeCompare(right.folder);
}

/**
 * First element of `values` after lexicographic sorting, or `null` if
 * the set is empty. Used to produce stable, deterministic diagnostics.
 * @param values Set of strings to sort.
 * @returns Lexicographically smallest element, or `null` when empty.
 */
export function firstSorted(values: ReadonlySet<string>): string | null {
  return [...values].sort()[0] ?? null;
}

/**
 * Convert a folder key from the project graph (relative to `src/`, with
 * the root encoded as `.`) into its display path under `src/`.
 * @param folder Folder key as stored on `SourceModule.folder`.
 * @returns Display path rooted at `src/`.
 */
export function sourceFolderPath(folder: string): string {
  return folder === "." ? "src" : `src/${folder}`;
}
