import path from "node:path";
import ts from "typescript";
import { candidateFileNames, collectPackageExportEntries } from "../project/api/index.js";
import type { PackageJson, ResolvedArchitectureOptions } from "../project/api/index.js";

const DEFAULT_PUBLIC_ENTRYPOINTS = [
  "src/index.ts",
  "src/index.tsx",
  "index.ts",
  "index.tsx",
] as const;

export function publicApiFileNames(
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): ReadonlySet<string> {
  const publicFiles = new Set<string>();
  addPackagePublicFiles(publicFiles, packageJson, sourceFilesByPath, options);
  if (publicFiles.size === 0) addDefaultPublicFiles(publicFiles, options.projectRoot);
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
    if (sourceFilesByPath.has(candidate)) publicFiles.add(candidate);
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
