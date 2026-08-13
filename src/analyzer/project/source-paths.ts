/**
 * @file Extension handling for source paths. Import specifiers are written
 * against emitted `.js` names while analysis reads the `.ts` files on disk,
 * so every path comparison has to translate between the two spellings.
 */

import path from "node:path";

/** Extensions whose files the analyzer treats as project source. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const OUTPUT_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * Drop a recognized source or emitted extension from a file name, leaving
 * an unrecognized suffix alone. `.d.ts` is matched ahead of `.ts` so the
 * whole declaration suffix comes off rather than half of it.
 * @param fileName File name to take the trailing extension off.
 * @returns The name without its recognized extension.
 */
export function stripKnownExtension(fileName: string): string {
  const extension = [".d.ts", ...SOURCE_EXTENSIONS, ...OUTPUT_EXTENSIONS].find((candidate) =>
    fileName.endsWith(candidate),
  );
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

/**
 * Swap a recognized source or emitted extension for another, appending
 * when the name carries no recognized extension at all.
 * @param fileName File name to rewrite the extension of.
 * @param nextExtension Replacement extension, leading dot included.
 * @returns The same name spelled with `nextExtension`.
 */
export function replaceKnownExtension(fileName: string, nextExtension: string): string {
  const extension = [".d.ts", ...SOURCE_EXTENSIONS, ...OUTPUT_EXTENSIONS].find((candidate) =>
    fileName.endsWith(candidate),
  );
  return extension
    ? `${fileName.slice(0, -extension.length)}${nextExtension}`
    : `${fileName}${nextExtension}`;
}

/**
 * List the absolute source files an import target could stand for, covering
 * both the written name with each source extension substituted and the bare
 * stem with each appended. Duplicates collapse and the order follows
 * `SOURCE_EXTENSIONS`, so resolution settles on the same file every run.
 * @param absolutePath Import target already resolved to an absolute path.
 * @returns Distinct candidates, in the order resolution should try them.
 */
export function candidateFileNames(absolutePath: string): readonly string[] {
  const extensionCandidates = SOURCE_EXTENSIONS.map((extension) =>
    path.resolve(replaceKnownExtension(absolutePath, extension)),
  );
  const stripped = stripKnownExtension(absolutePath);
  const strippedCandidates = SOURCE_EXTENSIONS.map((extension) =>
    path.resolve(`${stripped}${extension}`),
  );

  return [...new Set([...extensionCandidates, ...strippedCandidates])];
}

/**
 * Terminate a directory path with the platform separator so that the
 * prefix tests built on it cannot match a sibling directory whose name
 * merely starts with the same characters.
 * @param directory Directory path used as a containment prefix.
 * @returns The path guaranteed to end in a separator.
 */
export function withTrailingSeparator(directory: string): string {
  return directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
}
