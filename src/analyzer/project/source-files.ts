import path from "node:path";
import ts from "typescript";
import { replaceKnownExtension, SOURCE_EXTENSIONS, withTrailingSeparator } from "./source-paths.js";
import { collectPackageExportEntries } from "./package-exports/index.js";
import type { PackageJson, ResolvedArchitectureOptions } from "./diagnostics/index.js";

const PUBLIC_ENTRYPOINT_CANDIDATES = [
  "src/index.ts",
  "src/index.tsx",
  "index.ts",
  "index.tsx",
] as const;

export function createProgram(
  options: ResolvedArchitectureOptions,
  oldProgram?: ts.Program,
): ts.Program | null {
  const configPath =
    options.tsconfigPath ??
    ts.findConfigFile(options.projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return null;

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) return null;

  // A tsconfig found above the workspace root may enumerate a whole
  // monorepo; scope the ROOT file set to this workspace so each engine
  // pays for its own folder, not the repository. Imported dependencies
  // outside the root still load transitively.
  const root = withTrailingSeparator(path.resolve(options.projectRoot));
  const scoped = parsed.fileNames.filter((fileName) =>
    path.resolve(fileName).startsWith(root),
  );
  const rootNames = scoped.length > 0 ? scoped : parsed.fileNames;

  // Passing the previous program lets TypeScript reuse every unchanged
  // SourceFile, turning per-save rebuilds from cold to incremental.
  return ts.createProgram(rootNames, analysisOptions(parsed.options), undefined, oldProgram);
}

/**
 * Neutralize inherited build and emit modes for the analysis program:
 * force `noEmit`, and disable composite, declaration, and incremental
 * modes. Lib diagnostics are skipped because analysis consumes checker
 * symbols but does not need to validate dependency declarations. These
 * are isolation safeguards; root-file scoping reduces cold cost, while
 * previous-program reuse speeds incremental rebuilds.
 */
function analysisOptions(base: ts.CompilerOptions): ts.CompilerOptions {
  const inherited = { ...base };
  delete inherited.declarationMap;
  delete inherited.sourceMap;
  delete inherited.tsBuildInfoFile;

  return {
    ...inherited,
    noEmit: true,
    composite: false,
    declaration: false,
    incremental: false,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
  };
}

/** Why `createProgram` would return null, in user-actionable terms. */
export interface ProgramHealth {
  readonly status: "ok" | "missing-tsconfig" | "invalid-tsconfig";
  /** Path of the tsconfig involved (null when none was found). */
  readonly configPath: string | null;
  /** Human-readable cause; empty when status is "ok". */
  readonly detail: string;
}

export function programHealth(options: ResolvedArchitectureOptions): ProgramHealth {
  const configPath =
    options.tsconfigPath ??
    ts.findConfigFile(options.projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return {
      status: "missing-tsconfig",
      configPath: null,
      detail: `no tsconfig.json found at or above ${options.projectRoot}; architecture analysis needs a TypeScript project`,
    };
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    const text =
      first === undefined ? "unknown parse error" : ts.flattenDiagnosticMessageText(first.messageText, "; ");
    return {
      status: "invalid-tsconfig",
      configPath,
      detail: `tsconfig at ${configPath} failed to parse: ${text}`,
    };
  }
  return { status: "ok", configPath, detail: "" };
}

export function projectSourceFiles(
  program: ts.Program,
  projectRoot: string,
): readonly ts.SourceFile[] {
  const root = withTrailingSeparator(path.resolve(projectRoot));
  return program
    .getSourceFiles()
    .filter((sourceFile) => isProjectSourceFile(sourceFile, root))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function findPackageReportFile(
  sourceFiles: readonly ts.SourceFile[],
  projectRoot: string,
): string {
  const sourceFileNames = new Set(
    sourceFiles.map((sourceFile) => path.resolve(sourceFile.fileName)),
  );
  const candidates = PUBLIC_ENTRYPOINT_CANDIDATES.map(
    (candidate) => path.resolve(projectRoot, candidate),
  );

  return (
    candidates.find((candidate) => sourceFileNames.has(candidate)) ??
    sourceFiles[0]?.fileName ??
    path.join(projectRoot, "package.json")
  );
}

export function publicApiSourceFiles(
  program: ts.Program,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): readonly ts.SourceFile[] {
  const projectFiles = projectSourceFiles(program, options.projectRoot);
  const byPath = new Map(
    projectFiles.map((sourceFile) => [path.resolve(sourceFile.fileName), sourceFile] as const),
  );
  const publicFiles = packageJsonPublicFiles(packageJson, options.projectRoot, byPath);
  if (publicFiles.size === 0) addEntrypointPublicFiles(publicFiles, options.projectRoot, byPath);
  return [...publicFiles];
}

function packageJsonPublicFiles(
  packageJson: PackageJson,
  projectRoot: string,
  byPath: ReadonlyMap<string, ts.SourceFile>,
): Set<ts.SourceFile> {
  const publicFiles = new Set<ts.SourceFile>();
  for (const entry of collectPackageExportEntries(packageJson)) {
    const sourcePath = sourcePathForPackageTarget(entry.targetPath, projectRoot, byPath);
    const sourceFile = sourcePath ? byPath.get(sourcePath) : undefined;
    if (sourceFile) publicFiles.add(sourceFile);
  }
  return publicFiles;
}

function addEntrypointPublicFiles(
  publicFiles: Set<ts.SourceFile>,
  projectRoot: string,
  byPath: ReadonlyMap<string, ts.SourceFile>,
): void {
  for (const candidate of PUBLIC_ENTRYPOINT_CANDIDATES) {
    const sourceFile = byPath.get(path.resolve(projectRoot, candidate));
    if (sourceFile) publicFiles.add(sourceFile);
  }
}

function sourcePathForPackageTarget(
  targetPath: string,
  projectRoot: string,
  sourceFiles: ReadonlyMap<string, ts.SourceFile>,
): string | null {
  const normalizedTarget = targetPath.replaceAll("\\", "/");
  const targetWithoutPrefix = normalizedTarget.startsWith("./")
    ? normalizedTarget.slice(2)
    : normalizedTarget;
  const candidates = candidateSourcePaths(targetWithoutPrefix, projectRoot);
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
}

function candidateSourcePaths(targetWithoutPrefix: string, projectRoot: string): string[] {
  const relativePaths = targetWithoutPrefix.startsWith("dist/")
    ? [targetWithoutPrefix, `src/${targetWithoutPrefix.slice("dist/".length)}`]
    : [targetWithoutPrefix];

  return relativePaths.flatMap((relativePath) =>
    SOURCE_EXTENSIONS.map((extension) =>
      path.resolve(projectRoot, replaceKnownExtension(relativePath, extension)),
    ),
  );
}

function isProjectSourceFile(sourceFile: ts.SourceFile, projectRootWithSlash: string): boolean {
  const fileName = path.resolve(sourceFile.fileName);
  return (
    fileName.startsWith(projectRootWithSlash) &&
    !sourceFile.isDeclarationFile &&
    !fileName.includes(`${path.sep}node_modules${path.sep}`)
  );
}
