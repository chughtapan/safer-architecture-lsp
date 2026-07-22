import path from "node:path";
import ts from "typescript";
import { uniqueDiagnostics } from "../project/api/index.js";
import {
  exportedDeclarationName,
  hasExportModifier,
} from "../project/index.js";
import { packageAllowedInPublicTypes, packageNameFromSpecifier } from "../type-surface/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import type { ProjectArchitectureGraph, SourceModule } from "../project/index.js";

export function checkPublicSurface(
  graph: ProjectArchitectureGraph,
  sourceFiles: readonly ts.SourceFile[],
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const sourceFileByName = new Map(
    sourceFiles.map((sourceFile) => [path.resolve(sourceFile.fileName), sourceFile] as const),
  );

  return uniqueDiagnostics([
    ...exportStarBoundaryDiagnostics(graph),
    ...largePublicSurfaceDiagnostics(graph, options),
    ...curatedPublicFacadeDiagnostics(graph, options),
    ...publicTestHelperLeakDiagnostics(graph),
    ...boundaryOwnedTypeDiagnostics(graph, sourceFileByName, options),
  ]);
}

function exportStarBoundaryDiagnostics(
  graph: ProjectArchitectureGraph,
): readonly ArchitectureDiagnostic[] {
  return graph.modules.flatMap((module) => {
    if (module.starExportCount === 0) return [];
    if (!module.isPublic && !module.isIndex) return [];

    return [
      {
        ruleId: "no-export-star-boundary",
        file: module.fileName,
        severity: "warn",
        message:
          `${module.relativePath} uses ${module.starExportCount} export-star boundary ` +
          "declaration(s). export * makes the boundary inherit every future export " +
          "from the target module.",
      },
    ];
  });
}

function largePublicSurfaceDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.publicModules.flatMap((module) => {
    const diagnostics: ArchitectureDiagnostic[] = [];

    if (module.exportedSymbolCount > options.maxPublicExports) {
      diagnostics.push({
        ruleId: "no-large-public-surface",
        file: module.fileName,
        severity: "warn",
        message:
          `${module.relativePath} exports ${module.exportedSymbolCount} public symbols. ` +
          `The default budget is ${options.maxPublicExports}; split concrete surfaces ` +
          "behind narrower, named entrypoints.",
      });
    }

    if (module.localReexportCount > options.maxPublicReexports) {
      diagnostics.push({
        ruleId: "no-large-public-surface",
        file: module.fileName,
        severity: "warn",
        message:
          `${module.relativePath} re-exports ${module.localReexportCount} local modules. ` +
          `The default budget is ${options.maxPublicReexports}; a root entrypoint ` +
          "should curate a contract, not load the package graph.",
      });
    }

    return diagnostics;
  });
}

function curatedPublicFacadeDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.publicModules.flatMap((module) => {
    if (!module.isIndex) return [];
    if (
      module.starExportCount === 0 &&
      module.localReexportCount < options.minPublicFacadeModules
    ) {
      return [];
    }

    return [
      {
        ruleId: "require-curated-public-facade",
        file: module.fileName,
        severity: "warn",
        message:
          `${module.relativePath} is a public facade but exposes ` +
          `${module.localReexportCount} local re-export(s) and ` +
          `${module.starExportCount} export-star declaration(s). Public facades should ` +
          "name a small semantic contract: ports, factories, stable types, and registries.",
      },
    ];
  });
}

function publicTestHelperLeakDiagnostics(
  graph: ProjectArchitectureGraph,
): readonly ArchitectureDiagnostic[] {
  return graph.publicModules.flatMap((module) => {
    const leakedEdges = module.localEdges.filter((edge) => {
      const target = graph.modulesByFileName.get(edge.to);
      return target ? edge.kind === "reexport" && target.isTestLike : false;
    });
    if (leakedEdges.length === 0) return [];

    return [
      {
        ruleId: "no-public-test-helper-leak",
        file: module.fileName,
        severity: "warn",
        message:
          `${module.relativePath} is part of the public package API and exposes test-only ` +
          "shape. Test helpers should live behind an explicitly allowed testing subpath.",
      },
    ];
  });
}

function boundaryOwnedTypeDiagnostics(
  graph: ProjectArchitectureGraph,
  sourceFileByName: ReadonlyMap<string, ts.SourceFile>,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.publicModules.flatMap((module) => {
    const sourceFile = sourceFileByName.get(module.fileName);
    if (!sourceFile) return [];

    const importedTypes = externalImportedIdentifiers(sourceFile, options);
    if (importedTypes.size === 0) {
      return externalReexportBoundaryOwnedDiagnostics(sourceFile, module, options);
    }

    return [
      ...externalReexportBoundaryOwnedDiagnostics(sourceFile, module, options),
      ...exportedDeclarationTypeDiagnostics(sourceFile, module, importedTypes),
    ];
  });
}

function externalReexportBoundaryOwnedDiagnostics(
  sourceFile: ts.SourceFile,
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) return [];
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];

    const packageName = packageNameFromSpecifier(statement.moduleSpecifier.text);
    if (packageName === null || packageAllowedInPublicTypes(packageName, options)) return [];

    return [
      {
        ruleId: "require-boundary-owned-types",
        file: sourceFile.fileName,
        severity: "error",
        message:
          `${module.relativePath} re-exports "${packageName}" directly. Public boundaries ` +
          "should expose package-owned names and wrap vendor or infrastructure types.",
      },
    ];
  });
}

function exportedDeclarationTypeDiagnostics(
  sourceFile: ts.SourceFile,
  module: SourceModule,
  importedTypes: ReadonlyMap<string, string>,
): readonly ArchitectureDiagnostic[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!hasExportModifier(statement)) return [];

    const exportedName = exportedDeclarationName(statement);
    if (!exportedName) return [];

    const packages = importedPackagesReferencedByNode(statement, importedTypes);
    return [...packages].map((packageName) => ({
      ruleId: "require-boundary-owned-types",
      file: sourceFile.fileName,
      severity: "error",
      message:
        `${module.relativePath} export "${exportedName}" mentions "${packageName}" ` +
        "directly. Define a boundary-owned type and translate at the adapter edge.",
    }));
  });
}

function externalImportedIdentifiers(
  sourceFile: ts.SourceFile,
  options: ResolvedArchitectureOptions,
): ReadonlyMap<string, string> {
  const identifiers = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    addExternalImportedIdentifiers(identifiers, statement, options);
  }
  return identifiers;
}

function addExternalImportedIdentifiers(
  identifiers: Map<string, string>,
  statement: ts.Statement,
  options: ResolvedArchitectureOptions,
): void {
  if (!ts.isImportDeclaration(statement)) return;
  const packageName = externalPackageNameFromImport(statement, options);
  if (packageName === null || !statement.importClause) return;
  addImportClauseIdentifiers(identifiers, statement.importClause, packageName);
}

function externalPackageNameFromImport(
  statement: ts.ImportDeclaration,
  options: ResolvedArchitectureOptions,
): string | null {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const packageName = packageNameFromSpecifier(statement.moduleSpecifier.text);
  if (packageName === null) return null;
  return packageAllowedInPublicTypes(packageName, options) ? null : packageName;
}

function addImportClauseIdentifiers(
  identifiers: Map<string, string>,
  importClause: ts.ImportClause,
  packageName: string,
): void {
  if (importClause.name) identifiers.set(importClause.name.text, packageName);
  if (importClause.namedBindings) {
    addNamedBindingIdentifiers(identifiers, importClause.namedBindings, packageName);
  }
}

function addNamedBindingIdentifiers(
  identifiers: Map<string, string>,
  namedBindings: ts.NamedImportBindings,
  packageName: string,
): void {
  if (ts.isNamespaceImport(namedBindings)) {
    identifiers.set(namedBindings.name.text, packageName);
    return;
  }
  for (const element of namedBindings.elements) {
    identifiers.set(element.name.text, packageName);
  }
}

function importedPackagesReferencedByNode(
  node: ts.Node,
  importedTypes: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const packages = new Set<string>();

  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      const packageName = importedTypes.get(current.text);
      if (packageName) packages.add(packageName);
    }
    ts.forEachChild(current, visit);
  };

  ts.forEachChild(node, visit);
  return packages;
}
