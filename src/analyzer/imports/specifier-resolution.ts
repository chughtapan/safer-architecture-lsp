import path from "node:path";
import ts from "typescript";
import type { ModuleResolutionSnapshotEntry } from "../project/index.js";
import { candidateFileNames, SOURCE_EXTENSIONS } from "../project/api/index.js";

/**
 * One TypeScript module resolver and exact-result cache per project graph.
 * TypeScript owns package imports, paths aliases, module suffixes, rootDirs,
 * and extension substitution; the fallback retains the old relative resolver
 * for incomplete fixture/compiler configurations.
 */
export class CachedModuleResolver {
  readonly #sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>;
  readonly #compilerOptions: ts.CompilerOptions;
  readonly #typescriptCache: ts.ModuleResolutionCache;
  readonly #results = new Map<string, ModuleResolutionSnapshotEntry>();

  constructor(
    projectRoot: string,
    sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
    compilerOptions: ts.CompilerOptions,
  ) {
    this.#sourceFilesByPath = sourceFilesByPath;
    this.#compilerOptions = compilerOptions;
    this.#typescriptCache = ts.createModuleResolutionCache(
      projectRoot,
      canonicalFileName,
      compilerOptions,
    );
  }

  resolveLocal(fromFile: string, specifier: string): string | null {
    const key = resolutionKey(fromFile, specifier);
    const cached = this.#results.get(key);
    if (cached !== undefined) {return cached.targetFile;}

    const targetFile = this.#resolveWithTypeScript(fromFile, specifier) ??
      resolveRelativeFallback(fromFile, specifier, this.#sourceFilesByPath);
    this.#results.set(key, {
      fromFile: path.resolve(fromFile),
      specifier,
      targetFile,
    });
    return targetFile;
  }

  snapshot(): readonly ModuleResolutionSnapshotEntry[] {
    return [...this.#results.values()].sort(compareSnapshotEntries);
  }

  #resolveWithTypeScript(fromFile: string, specifier: string): string | null {
    const resolution = ts.resolveModuleName(
      specifier,
      fromFile,
      this.#compilerOptions,
      ts.sys,
      this.#typescriptCache,
    ).resolvedModule;
    if (resolution === undefined) {return null;}

    const resolvedFileName = path.resolve(resolution.resolvedFileName);
    return this.#sourceFilesByPath.has(resolvedFileName) ? resolvedFileName : null;
  }
}

function resolveRelativeFallback(
  fromFile: string,
  specifier: string,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): string | null {
  if (!specifier.startsWith(".")) {return null;}

  const absolute = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    ...candidateFileNames(absolute),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(absolute, `index${extension}`)),
  ];
  return candidates.find((candidate) => sourceFilesByPath.has(candidate)) ?? null;
}

function resolutionKey(fromFile: string, specifier: string): string {
  return `${path.resolve(fromFile)}\0${specifier}`;
}

function canonicalFileName(fileName: string): string {
  return ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
}

function compareSnapshotEntries(
  left: ModuleResolutionSnapshotEntry,
  right: ModuleResolutionSnapshotEntry,
): number {
  const fromComparison = left.fromFile.localeCompare(right.fromFile);
  return fromComparison === 0
    ? left.specifier.localeCompare(right.specifier)
    : fromComparison;
}
