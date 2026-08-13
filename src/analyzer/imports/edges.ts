import path from "node:path";
import ts from "typescript";
import type {
  ExternalModuleEdge,
  LocalModuleEdge,
  ModuleEdgeKind,
} from "../project/index.js";
import type { CachedModuleResolver } from "./specifier-resolution.js";

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
  if (statement.importClause?.isTypeOnly) {return true;}
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
