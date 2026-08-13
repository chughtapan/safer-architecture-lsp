/**
 * @file Exported-symbol and export-consumer extraction. Two questions are
 * answered from source text alone: which names a file exports, and which of
 * those names each importer actually reaches for. Named imports, named
 * re-exports, and members read off a namespace import all count, so a rule
 * can tell a genuinely used export from one that is merely re-exported.
 */

import path from "node:path";
import ts from "typescript";
import type { ExportConsumer } from "../project/index.js";
import type { CachedModuleResolver } from "./specifier-resolution.js";

interface ImportTargetContext {
  readonly fromFile: string;
  readonly targetFile: string;
  readonly typeOnly: boolean;
}

interface NamespaceImportBinding extends ImportTargetContext {
  readonly localName: string;
}

/**
 * List the names a file exports, across export declarations, export
 * assignments, and declarations carrying an `export` modifier. Anonymous
 * default exports are recorded under the name `default`.
 * @param sourceFile File whose top-level statements are inspected.
 * @returns Deduplicated names in sorted order, so the result does not follow statement order.
 */
export function collectExportedSymbolNames(sourceFile: ts.SourceFile): readonly string[] {
  const symbols = new Set<string>();
  for (const statement of sourceFile.statements) {
    addExportedSymbolNames(symbols, statement);
  }
  return [...symbols].sort(compareStrings);
}

/**
 * Record who uses which export of which project file. A namespace import
 * contributes one record per member actually accessed rather than one for the
 * whole module, so wildcard access does not read as using everything.
 * @param sourceFiles Files scanned for uses of project-local exports.
 * @param resolver Maps a specifier onto the project file it names; unresolved specifiers are skipped.
 * @returns Consumer records ordered by target file, export name, consumer file, and kind.
 */
export function collectExportConsumers(
  sourceFiles: readonly ts.SourceFile[],
  resolver: CachedModuleResolver,
): readonly ExportConsumer[] {
  return sourceFiles
    .flatMap((sourceFile) => [
      ...namedImportConsumers(sourceFile, resolver),
      ...namedReexportConsumers(sourceFile, resolver),
      ...namespaceImportConsumers(sourceFile, resolver),
    ])
    .sort(compareExportConsumers);
}

function addExportedSymbolNames(
  symbols: Set<string>,
  statement: ts.Statement,
): void {
  if (ts.isExportDeclaration(statement)) {
    addExportDeclarationNames(symbols, statement);
    return;
  }
  if (ts.isExportAssignment(statement)) {
    symbols.add("default");
    return;
  }
  if (!hasExportModifier(statement)) {return;}
  addExportedDeclarationNames(symbols, statement);
}

function addExportDeclarationNames(
  symbols: Set<string>,
  statement: ts.ExportDeclaration,
): void {
  const exportClause = statement.exportClause;
  if (!exportClause) {return;}
  if (ts.isNamespaceExport(exportClause)) {
    symbols.add(exportClause.name.text);
    return;
  }
  for (const element of exportClause.elements) {
    symbols.add(element.name.text);
  }
}

function addExportedDeclarationNames(
  symbols: Set<string>,
  statement: ts.Statement,
): void {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      addBindingName(symbols, declaration.name);
    }
    return;
  }
  const name = exportedDeclarationName(statement);
  symbols.add(name ?? "default");
}

function addBindingName(symbols: Set<string>, name: ts.BindingName): void {
  if (ts.isIdentifier(name)) {symbols.add(name.text);}
}

function namedImportConsumers(
  sourceFile: ts.SourceFile,
  resolver: CachedModuleResolver,
): readonly ExportConsumer[] {
  return sourceFile.statements.flatMap((statement) =>
    importDeclarationConsumers(sourceFile.fileName, statement, resolver)
  );
}

function importDeclarationConsumers(
  fromFile: string,
  statement: ts.Statement,
  resolver: CachedModuleResolver,
): readonly ExportConsumer[] {
  if (!ts.isImportDeclaration(statement)) {return [];}
  const context = importTargetContext(fromFile, statement, resolver);
  if (context === null || !statement.importClause) {return [];}
  return importClauseConsumers(statement.importClause, context);
}

function importClauseConsumers(
  importClause: ts.ImportClause,
  context: ImportTargetContext,
): readonly ExportConsumer[] {
  const consumers: ExportConsumer[] = [];
  if (importClause.name) {
    consumers.push(exportConsumer(context, "default", "import"));
  }
  if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
    consumers.push(...namedImportBindingConsumers(importClause.namedBindings, context));
  }
  return consumers;
}

function namedImportBindingConsumers(
  namedImports: ts.NamedImports,
  context: ImportTargetContext,
): readonly ExportConsumer[] {
  return namedImports.elements.map((element) =>
    exportConsumer(
      { ...context, typeOnly: context.typeOnly || element.isTypeOnly },
      importedExportName(element),
      "import",
    )
  );
}

function namedReexportConsumers(
  sourceFile: ts.SourceFile,
  resolver: CachedModuleResolver,
): readonly ExportConsumer[] {
  return sourceFile.statements.flatMap((statement) =>
    exportDeclarationConsumers(sourceFile.fileName, statement, resolver)
  );
}

function exportDeclarationConsumers(
  fromFile: string,
  statement: ts.Statement,
  resolver: CachedModuleResolver,
): readonly ExportConsumer[] {
  if (!ts.isExportDeclaration(statement)) {return [];}
  if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {return [];}
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {return [];}

  const targetFile = resolver.resolveLocal(fromFile, statement.moduleSpecifier.text);
  if (targetFile === null) {return [];}

  return statement.exportClause.elements.map((element) =>
    exportConsumer(
      {
        fromFile: path.resolve(fromFile),
        targetFile,
        typeOnly: statement.isTypeOnly || element.isTypeOnly,
      },
      importedExportName(element),
      "reexport",
    )
  );
}

function namespaceImportConsumers(
  sourceFile: ts.SourceFile,
  resolver: CachedModuleResolver,
): readonly ExportConsumer[] {
  const bindings = namespaceImportBindings(sourceFile, resolver);
  if (bindings.size === 0) {return [];}
  return namespaceMemberUses(sourceFile, bindings);
}

function namespaceImportBindings(
  sourceFile: ts.SourceFile,
  resolver: CachedModuleResolver,
): ReadonlyMap<string, NamespaceImportBinding> {
  const bindings = new Map<string, NamespaceImportBinding>();
  for (const statement of sourceFile.statements) {
    addNamespaceImportBinding(bindings, sourceFile.fileName, statement, resolver);
  }
  return bindings;
}

function addNamespaceImportBinding(
  bindings: Map<string, NamespaceImportBinding>,
  fromFile: string,
  statement: ts.Statement,
  resolver: CachedModuleResolver,
): void {
  if (!ts.isImportDeclaration(statement)) {return;}
  const context = importTargetContext(fromFile, statement, resolver);
  const namespaceImport = resolveNamespaceImportFromClause(statement.importClause);
  if (context === null || namespaceImport === null) {return;}
  bindings.set(namespaceImport.name.text, {
    ...context,
    localName: namespaceImport.name.text,
  });
}

function importTargetContext(
  fromFile: string,
  statement: ts.ImportDeclaration,
  resolver: CachedModuleResolver,
): ImportTargetContext | null {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {return null;}
  const targetFile = resolver.resolveLocal(fromFile, statement.moduleSpecifier.text);
  if (targetFile === null) {return null;}
  return {
    fromFile: path.resolve(fromFile),
    targetFile,
    typeOnly: statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
  };
}

function resolveNamespaceImportFromClause(
  importClause?: ts.ImportClause,
): ts.NamespaceImport | null {
  const namedBindings = importClause?.namedBindings;
  return namedBindings && ts.isNamespaceImport(namedBindings) ? namedBindings : null;
}

function namespaceMemberUses(
  sourceFile: ts.SourceFile,
  bindings: ReadonlyMap<string, NamespaceImportBinding>,
): readonly ExportConsumer[] {
  const consumers: ExportConsumer[] = [];
  const visit = (node: ts.Node): void => {
    const consumer = namespaceMemberConsumer(node, bindings);
    if (consumer !== null) {consumers.push(consumer);}
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return consumers;
}

function namespaceMemberConsumer(
  node: ts.Node,
  bindings: ReadonlyMap<string, NamespaceImportBinding>,
): ExportConsumer | null {
  if (!ts.isPropertyAccessExpression(node)) {return null;}
  if (!ts.isIdentifier(node.expression)) {return null;}
  const binding = bindings.get(node.expression.text);
  return binding === undefined
    ? null
    : exportConsumer(binding, node.name.text, "import");
}

function exportConsumer(
  context: ImportTargetContext,
  exportName: string,
  kind: ExportConsumer["kind"],
): ExportConsumer {
  return {
    exportName,
    consumerFile: context.fromFile,
    targetFile: context.targetFile,
    kind,
    typeOnly: context.typeOnly,
  };
}

function importedExportName(element: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return element.propertyName?.text ?? element.name.text;
}

function compareExportConsumers(
  left: ExportConsumer,
  right: ExportConsumer,
): number {
  return consumerSortKey(left).localeCompare(consumerSortKey(right));
}

function consumerSortKey(consumer: ExportConsumer): string {
  return [
    consumer.targetFile,
    consumer.exportName,
    consumer.consumerFile,
    consumer.kind,
  ].join("\0");
}

function hasExportModifier(statement: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

type DeclarationNameReader = (statement: ts.Statement) => string | null | undefined;

const DECLARATION_NAME_READERS: readonly DeclarationNameReader[] = [
  (statement) => ts.isFunctionDeclaration(statement) ? statement.name?.text ?? null : undefined,
  (statement) => ts.isClassDeclaration(statement) ? statement.name?.text ?? null : undefined,
  (statement) => ts.isInterfaceDeclaration(statement) ? statement.name.text : undefined,
  (statement) => ts.isTypeAliasDeclaration(statement) ? statement.name.text : undefined,
  (statement) => ts.isEnumDeclaration(statement) ? statement.name.text : undefined,
];

function exportedDeclarationName(statement: ts.Statement): string | null {
  for (const reader of DECLARATION_NAME_READERS) {
    const name = reader(statement);
    if (name !== undefined) {return name;}
  }
  return null;
}

// Code-unit order, identical to a bare `sort()` but independent of host locale.
function compareStrings(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
