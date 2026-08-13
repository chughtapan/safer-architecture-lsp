/**
 * @file Module-edge extraction from one source file. Every import and every
 * re-export with a specifier becomes either a local edge, when the specifier
 * resolves to a file inside the project, or an external package edge.
 * Type-only and side-effect-only specifiers are flagged here because the
 * architecture rules downstream weigh them differently from value imports.
 */

import path from "node:path";
import ts from "typescript";
import type {
  ExternalModuleEdge,
  LocalModuleEdge,
  ModuleEdgeKind,
} from "../project/index.js";
import type { CachedModuleResolver } from "./specifier-resolution.js";

/**
 * The two disjoint edge sets one source file contributes to the project
 * graph: dependencies on other project files, and dependencies on installed
 * packages.
 */
export interface ModuleEdges {
  readonly localEdges: readonly LocalModuleEdge[];
  readonly externalEdges: readonly ExternalModuleEdge[];
}

interface SpecifierEdgeContext {
  readonly fromFile: string;
  readonly moduleSpecifier: ts.Expression;
  readonly typeOnly: boolean;
  readonly kind: ModuleEdgeKind;
  readonly resolver: CachedModuleResolver;
  readonly sideEffectOnly: boolean;
}

/**
 * Split a file's top-level module specifiers into project-local and external
 * edges. A specifier that neither resolves to a project file nor names a
 * package is dropped rather than reported, so unresolvable paths cannot
 * manufacture phantom dependencies.
 * @param sourceFile File whose import and re-export statements are read.
 * @param resolver Decides whether a specifier lands inside the project.
 * @returns Both edge sets, in the order the statements appear.
 */
export function collectModuleEdges(
  sourceFile: ts.SourceFile,
  resolver: CachedModuleResolver,
): ModuleEdges {
  const localEdges: LocalModuleEdge[] = [];
  const externalEdges: ExternalModuleEdge[] = [];

  for (const statement of sourceFile.statements) {
    const context = specifierEdgeContext(sourceFile, statement, resolver);
    if (context !== null) {collectSpecifierEdge(context, localEdges, externalEdges);}
  }

  return { localEdges, externalEdges };
}

function specifierEdgeContext(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  resolver: CachedModuleResolver,
): SpecifierEdgeContext | null {
  if (ts.isImportDeclaration(statement)) {
    return {
      fromFile: sourceFile.fileName,
      moduleSpecifier: statement.moduleSpecifier,
      typeOnly: importDeclarationIsTypeOnly(statement),
      kind: "import",
      resolver,
      sideEffectOnly: importDeclarationIsSideEffectOnly(statement),
    };
  }
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {return null;}
  return {
    fromFile: sourceFile.fileName,
    moduleSpecifier: statement.moduleSpecifier,
    typeOnly: exportDeclarationIsTypeOnly(statement),
    kind: "reexport",
    resolver,
    sideEffectOnly: false,
  };
}

function importDeclarationIsSideEffectOnly(statement: ts.ImportDeclaration): boolean {
  if (statement.importClause === undefined) {return true;}
  const { name, namedBindings } = statement.importClause;
  return name === undefined &&
    namedBindings !== undefined &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.length === 0;
}

function collectSpecifierEdge(
  context: SpecifierEdgeContext,
  localEdges: LocalModuleEdge[],
  externalEdges: ExternalModuleEdge[],
): void {
  if (!ts.isStringLiteral(context.moduleSpecifier)) {return;}
  const specifier = context.moduleSpecifier.text;
  const localTarget = context.resolver.resolveLocal(context.fromFile, specifier);
  if (localTarget) {
    localEdges.push(localModuleEdge(context, localTarget, specifier));
    return;
  }
  const packageName = packageNameFromSpecifier(specifier);
  if (packageName !== null) {
    externalEdges.push(externalModuleEdge(context, packageName, specifier));
  }
}

function localModuleEdge(
  context: SpecifierEdgeContext,
  localTarget: string,
  specifier: string,
): LocalModuleEdge {
  return {
    from: path.resolve(context.fromFile),
    to: localTarget,
    kind: context.kind,
    typeOnly: context.typeOnly,
    specifier,
    sideEffectOnly: context.sideEffectOnly,
  };
}

function externalModuleEdge(
  context: SpecifierEdgeContext,
  packageName: string,
  specifier: string,
): ExternalModuleEdge {
  return {
    from: path.resolve(context.fromFile),
    packageName,
    kind: context.kind,
    typeOnly: context.typeOnly,
    specifier,
  };
}

function importDeclarationIsTypeOnly(statement: ts.ImportDeclaration): boolean {
  if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {return true;}
  const namedBindings = statement.importClause?.namedBindings;
  return Boolean(
    namedBindings &&
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.length > 0 &&
      namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

function exportDeclarationIsTypeOnly(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) {return true;}
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {return false;}
  return statement.exportClause.elements.every((specifier) => specifier.isTypeOnly);
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {return null;}
  if (specifier.startsWith("node:")) {return "node";}

  const segments = specifier.split("/");
  if (segments[0]?.startsWith("@")) {return segments.slice(0, 2).join("/");}
  return segments[0] ?? null;
}
