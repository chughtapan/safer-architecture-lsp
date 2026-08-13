/**
 * @file Public entrypoint resolution. Maps the targets a manifest declares
 * back onto the project's own source files, so the surface checks know which
 * modules consumers can actually import. A `dist/` target also resolves
 * through its `src/` counterpart, since the published build is not analyzed.
 */

import type ts from "typescript";
import path from "node:path";
import { candidateFileNames, collectPackageExportEntries, type PackageJson, type ResolvedArchitectureOptions  } from "../project/api/index.js";

const DEFAULT_PUBLIC_ENTRYPOINTS = [
  "src/index.ts",
  "src/index.tsx",
  "index.ts",
  "index.tsx",
] as const;

/**
 * Resolve the source files reachable through the manifest's public exports.
 * Falls back to the conventional root entrypoints when the manifest declares
 * none, so a private or pre-`exports` project still has a public boundary.
 * @param sourceFilesByPath Parsed project files keyed by absolute path; a
 * manifest target only resolves if it lands on a key here.
 * @param packageJson Manifest whose export targets are resolved.
 * @param options Supplies the project root that targets resolve against.
 * @returns Absolute paths of the package's public entrypoints; the fallback
 * paths are candidates and need not exist on disk.
 */
export function publicApiFileNames(
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): ReadonlySet<string> {
  const publicFiles = new Set<string>();
  addPackagePublicFiles(publicFiles, packageJson, sourceFilesByPath, options);
  if (publicFiles.size === 0) {addDefaultPublicFiles(publicFiles, options.projectRoot);}
  return publicFiles;
}

function addPackagePublicFiles(
  publicFiles: Set<string>,
  packageJson: PackageJson,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
  options: ResolvedArchitectureOptions,
): void {
  for (const entry of collectPackageExportEntries(packageJson)) {
    addPackageExportPublicFiles(publicFiles, entry.targetPath, sourceFilesByPath, options);
  }
}

function addPackageExportPublicFiles(
  publicFiles: Set<string>,
  targetPath: string,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
  options: ResolvedArchitectureOptions,
): void {
  const candidates = sourceCandidatesForPackageTarget(targetPath, options.projectRoot);
  for (const candidate of candidates) {
    if (sourceFilesByPath.has(candidate)) {publicFiles.add(candidate);}
  }
}

function addDefaultPublicFiles(
  publicFiles: Set<string>,
  projectRoot: string,
): void {
  for (const candidate of DEFAULT_PUBLIC_ENTRYPOINTS) {
    publicFiles.add(path.resolve(projectRoot, candidate));
  }
}

function sourceCandidatesForPackageTarget(
  targetPath: string,
  projectRoot: string,
): readonly string[] {
  const targetWithoutPrefix = targetPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const relativePaths = targetWithoutPrefix.startsWith("dist/")
    ? [targetWithoutPrefix, `src/${targetWithoutPrefix.slice("dist/".length)}`]
    : [targetWithoutPrefix];

  return relativePaths.flatMap((relativePath) =>
    candidateFileNames(path.resolve(projectRoot, relativePath)),
  );
}
