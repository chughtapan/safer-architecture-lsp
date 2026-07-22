/**
 * @file Architecture analyzer entry point. Composes every analysis pass
 * (package exports, inventory barrels, vendor type leaks, public
 * surface, folder graph, folder/module shape) into the single project
 * report consumed by the architecture LSP server and CI shim.
 */

import path from "node:path";
import type ts from "typescript";
import { checkFolderShape } from "./folder-shape/index.js";
import { checkInventoryBarrels } from "./exports/inventory-barrels.js";
import { buildProjectGraph, checkFolderGraph } from "./imports/index.js";
import { checkModuleShape } from "./module-shape/index.js";
import {
  checkPackageExports,
  checkPublicSurface,
  emptyPackageJson,
  readPackageJson,
} from "./package-api/index.js";
import {
  createProgram,
  findPackageReportFile,
  programHealth,
  projectSourceFiles,
  uniqueDiagnostics,
} from "./project/api/index.js";
import { checkPublicVendorTypeLeaks } from "./type-surface/index.js";
import {
  buildDirectiveIndex,
  isDirectiveSuppressed,
  parseDirectivesFromSourceFile,
  type DirectiveIndex,
  type FileDirectives,
} from "./architecture-exceptions.js";
import {
  ARCHITECTURE_ANALYSIS_UNAVAILABLE_RULE_ID,
  ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
} from "./rule-ids.js";
import type {
  ArchitectureDiagnostic,
  ArchitectureDiagnosticRuleId,
  ArchitectureReport,
  ArchitectureWaiver,
  ResolvedArchitectureOptions,
} from "./project/api/index.js";

interface DirectiveAnalysis {
  readonly directiveErrorDiagnostics: readonly ArchitectureDiagnostic[];
  readonly directiveIndex: DirectiveIndex;
  readonly attemptedSuppressions: ReadonlyMap<string, ReadonlySet<ArchitectureDiagnosticRuleId>>;
  readonly waivers: readonly ArchitectureWaiver[];
}

/**
 * Run every architecture analysis pass (package exports, inventory
 * barrels, public vendor type leaks, public surface, folder graph,
 * folder shape, module shape) against pre-resolved options and return
 * the merged report with directive-based suppressions applied. The
 * cache layer calls this with pre-resolved options so options are not
 * re-decoded on every analyzer hit.
 * @param options Pre-resolved architecture options (already
 * schema-decoded and path-resolved).
 * @param programProvider Lazy provider for the `ts.Program`. The
 * default builds one from the project tsconfig via `createProgram`.
 * The LSP workspace engine supplies a provider that returns its
 * cached `ts.Program` so the analyzer does not parse every project
 * file on each diagnostic refresh.
 * @returns The combined architecture report with deduplicated
 * diagnostics, after directive suppressions are applied.
 */
export function analyzeResolvedArchitecture(
  options: ResolvedArchitectureOptions,
  programProvider: () => ts.Program | null = () => createProgram(options),
): ArchitectureReport {
  const packageJson = readPackageJson(options.projectRoot) ?? emptyPackageJson();
  const program = programProvider();
  const sourceFiles = program ? projectSourceFiles(program, options.projectRoot) : [];
  const unavailableDiagnostics = program === null ? analysisUnavailable(options) : [];
  const packageReportFile = findPackageReportFile(sourceFiles, options.projectRoot);
  const graph = buildProjectGraph(sourceFiles, packageJson, options, packageReportFile);
  const directiveAnalysis = analyzeDirectiveComments(sourceFiles);

  const allDiagnostics = uniqueDiagnostics([
    ...checkPackageExports(packageJson, options, packageReportFile),
    ...checkInventoryBarrels(sourceFiles, options),
    ...resolvePublicVendorTypeLeaks(program, packageJson, options),
    ...checkPublicSurface(graph, sourceFiles, options),
    ...checkFolderGraph(graph, options),
    ...checkFolderShape(graph, options),
    ...checkModuleShape(graph, options),
  ]);

  const diagnostics = [
    ...unavailableDiagnostics,
    ...directiveAnalysis.directiveErrorDiagnostics,
    ...filterSuppressedDiagnostics(allDiagnostics, directiveAnalysis),
  ];
  return {
    diagnostics,
    diagnosticsByFile: indexByFile(diagnostics),
    waivers: directiveAnalysis.waivers,
  };
}

function analysisUnavailable(
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const health = programHealth(options);
  if (health.status === "ok") return [];
  return [
    {
      ruleId: ARCHITECTURE_ANALYSIS_UNAVAILABLE_RULE_ID,
      file: health.configPath ?? path.join(options.projectRoot, "tsconfig.json"),
      severity: "error",
      message: `Architecture analysis did not run: ${health.detail}. Fix the TypeScript project configuration; until then this workspace has NO architecture coverage.`,
    },
  ];
}

function indexByFile(
  diagnostics: readonly ArchitectureDiagnostic[],
): ReadonlyMap<string, readonly ArchitectureDiagnostic[]> {
  const byFile = new Map<string, ArchitectureDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const bucket = byFile.get(diagnostic.file);
    if (bucket === undefined) byFile.set(diagnostic.file, [diagnostic]);
    else bucket.push(diagnostic);
  }
  return byFile;
}

function resolvePublicVendorTypeLeaks(
  program: ReturnType<typeof createProgram>,
  packageJson: ReturnType<typeof emptyPackageJson>,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return program === null ? [] : checkPublicVendorTypeLeaks(program, packageJson, options);
}

function analyzeDirectiveComments(
  sourceFiles: readonly ReturnType<typeof projectSourceFiles>[number][],
): DirectiveAnalysis {
  const fileDirectives: FileDirectives[] = [];
  const directiveErrorDiagnostics: ArchitectureDiagnostic[] = [];
  const attemptedSuppressions = new Map<string, Set<ArchitectureDiagnosticRuleId>>();

  for (const sourceFile of sourceFiles) {
    const result = parseDirectivesFromSourceFile(sourceFile);
    const resolvedFile = path.resolve(sourceFile.fileName);
    if (result.directives.length > 0) {
      fileDirectives.push({ file: resolvedFile, directives: result.directives });
    }
    for (const err of result.errors) {
      directiveErrorDiagnostics.push(directiveParseDiagnostic(resolvedFile, err));
      if (err.ruleId !== null) {
        recordAttemptedSuppression(attemptedSuppressions, resolvedFile, err.ruleId);
      }
    }
  }
  return {
    attemptedSuppressions,
    directiveErrorDiagnostics,
    directiveIndex: buildDirectiveIndex(fileDirectives),
    waivers: fileDirectives.flatMap(({ file, directives }) =>
      directives.map((d) => ({ file, ruleId: d.ruleId, reason: d.reason })),
    ),
  };
}

function directiveParseDiagnostic(
  resolvedFile: string,
  error: { readonly line: number; readonly message: string },
): ArchitectureDiagnostic {
  return {
    ruleId: ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
    file: resolvedFile,
    severity: "error",
    message: `Architecture directive parse error (line ${error.line}): ${error.message}`,
  };
}

function recordAttemptedSuppression(
  attemptedSuppressions: Map<string, Set<ArchitectureDiagnosticRuleId>>,
  resolvedFile: string,
  ruleId: ArchitectureDiagnosticRuleId,
): void {
  const set = attemptedSuppressions.get(resolvedFile) ?? new Set();
  set.add(ruleId);
  attemptedSuppressions.set(resolvedFile, set);
}

function filterSuppressedDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
  directiveAnalysis: DirectiveAnalysis,
): readonly ArchitectureDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    shouldKeepDiagnostic(diagnostic, directiveAnalysis)
  );
}

function shouldKeepDiagnostic(
  diagnostic: ArchitectureDiagnostic,
  directiveAnalysis: DirectiveAnalysis,
): boolean {
  if (diagnostic.ruleId === ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID) return true;
  const ruleId = diagnostic.ruleId as ArchitectureDiagnosticRuleId;
  const resolvedFile = path.resolve(diagnostic.file);
  if (isDirectiveSuppressed(directiveAnalysis.directiveIndex, resolvedFile, ruleId)) {
    return false;
  }
  return !directiveAnalysis.attemptedSuppressions.get(resolvedFile)?.has(ruleId);
}
