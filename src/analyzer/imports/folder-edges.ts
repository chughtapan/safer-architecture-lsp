/**
 * @file Collapse of module edges into folder-to-folder edges. An import
 * inside a single folder, or between a folder and its own ancestor or
 * descendant, is internal wiring rather than a dependency between folders and
 * is dropped. Surviving edges and their file lists are sorted so the folder
 * graph is byte-identical between runs.
 */

import type {
  FolderEdge,
  LocalModuleEdge,
  SourceModule,
} from "../project/index.js";

interface FolderEdgeRecord {
  readonly key: string;
  readonly fileName: string;
  readonly metadata: Omit<FolderEdge, "files">;
}

/**
 * Merge module edges that share a source folder, target folder, and edge
 * kind into one folder edge, keeping the set of importing files that produced
 * it so a diagnostic can point at real evidence.
 * @param localEdges Resolved module-to-module edges from every source file.
 * @param modulesByFileName Lookup that places each edge endpoint in its folder.
 * @returns Deduplicated folder edges in a fixed order, each listing the files behind it.
 */
export function collectFolderEdges(
  localEdges: readonly LocalModuleEdge[],
  modulesByFileName: ReadonlyMap<string, SourceModule>,
): readonly FolderEdge[] {
  const edgeFilesByKey = new Map<string, Set<string>>();
  const edgeMetadataByKey = new Map<string, Omit<FolderEdge, "files">>();

  for (const edge of localEdges) {
    const record = folderEdgeRecord(edge, modulesByFileName);
    if (record !== null) {
      addFolderEdgeRecord(record, edgeFilesByKey, edgeMetadataByKey);
    }
  }

  return [...edgeMetadataByKey.entries()]
    .map(([key, edge]) => ({
      ...edge,
      files: [...(edgeFilesByKey.get(key) ?? [])].sort(compareStrings),
    }))
    .sort(compareFolderEdges);
}

function folderEdgeRecord(
  edge: LocalModuleEdge,
  modulesByFileName: ReadonlyMap<string, SourceModule>,
): FolderEdgeRecord | null {
  const fromModule = modulesByFileName.get(edge.from);
  const toModule = modulesByFileName.get(edge.to);
  if (!fromModule || !toModule) {return null;}
  if (fromModule.folder === toModule.folder) {return null;}
  if (nestedNonRootFolderPair(fromModule.folder, toModule.folder)) {return null;}
  return {
    key: `${fromModule.folder}\0${toModule.folder}\0${edge.kind}`,
    fileName: fromModule.fileName,
    metadata: {
      from: fromModule.folder,
      to: toModule.folder,
      kind: edge.kind,
    },
  };
}

function nestedNonRootFolderPair(left: string, right: string): boolean {
  if (left === "." || right === ".") {return false;}
  return folderContains(left, right) || folderContains(right, left);
}

function folderContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function addFolderEdgeRecord(
  record: FolderEdgeRecord,
  edgeFilesByKey: Map<string, Set<string>>,
  edgeMetadataByKey: Map<string, Omit<FolderEdge, "files">>,
): void {
  const files = edgeFilesByKey.get(record.key) ?? new Set<string>();
  files.add(record.fileName);
  edgeFilesByKey.set(record.key, files);
  edgeMetadataByKey.set(record.key, record.metadata);
}

function compareFolderEdges(left: FolderEdge, right: FolderEdge): number {
  return folderEdgeKey(left).localeCompare(folderEdgeKey(right));
}

function folderEdgeKey(edge: FolderEdge): string {
  return `${edge.from}/${edge.to}/${edge.kind}`;
}

// Code-unit order, identical to a bare `sort()` but independent of host locale.
function compareStrings(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
