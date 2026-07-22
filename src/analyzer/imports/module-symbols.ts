import path from "node:path";
import ts from "typescript";
import { resolveLocalSpecifier } from "./specifier-resolution.js";
import type { ExportConsumer } from "../project/index.js";

interface ImportTargetContext {
  readonly fromFile: string;
  readonly targetFile: string;
  readonly typeOnly: boolean;
}

interface NamespaceImportBinding extends ImportTargetContext {
  readonly localName: string;
}

export function collectExportedSymbolNames(sourceFile: ts.SourceFile): readonly string[] {
  const symbols = new Set<string>();
  for (const statement of sourceFile.statements) {
    addExportedSymbolNames(symbols, statement);
  }
  return [...symbols].sort();
}

export function collectExportConsumers(
  sourceFiles: readonly ts.SourceFile[],
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): readonly ExportConsumer[] {
  return sourceFiles
    .flatMap((sourceFile) => [
      ...namedImportConsumers(sourceFile, sourceFilesByPath),
      ...namedReexportConsumers(sourceFile, sourceFilesByPath),
      ...namespaceImportConsumers(sourceFile, sourceFilesByPath),
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
  if (!hasExportModifier(statement)) return;
  addExportedDeclarationNames(symbols, statement);
}

function addExportDeclarationNames(
  symbols: Set<string>,
  statement: ts.ExportDeclaration,
): void {
  const exportClause = statement.exportClause;
  if (!exportClause) return;
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
  if (ts.isIdentifier(name)) symbols.add(name.text);
}

function namedImportConsumers(
  sourceFile: ts.SourceFile,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): readonly ExportConsumer[] {
  return sourceFile.statements.flatMap((statement) =>
    importDeclarationConsumers(sourceFile.fileName, statement, sourceFilesByPath)
  );
}

function importDeclarationConsumers(
  fromFile: string,
  statement: ts.Statement,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): readonly ExportConsumer[] {
  if (!ts.isImportDeclaration(statement)) return [];
  const context = importTargetContext(fromFile, statement, sourceFilesByPath);
  if (context === null || !statement.importClause) return [];
  return importClauseConsumers(statement.importClause, context);
}

function importTargetContext(
  fromFile: string,
  statement: ts.ImportDeclaration,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): ImportTargetContext | null {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return null;
  const targetFile = resolveLocalSpecifier(
    fromFile,
    statement.moduleSpecifier.text,
    sourceFilesByPath,
  );
  if (targetFile === null) return null;
  return {
    fromFile: path.resolve(fromFile),
    targetFile,
    typeOnly: statement.importClause?.isTypeOnly ?? false,
  };
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
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): readonly ExportConsumer[] {
  return sourceFile.statements.flatMap((statement) =>
    exportDeclarationConsumers(sourceFile.fileName, statement, sourceFilesByPath)
  );
}

function exportDeclarationConsumers(
  fromFile: string,
  statement: ts.Statement,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): readonly ExportConsumer[] {
  if (!ts.isExportDeclaration(statement)) return [];
  if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return [];

  const targetFile = resolveLocalSpecifier(
    fromFile,
    statement.moduleSpecifier.text,
    sourceFilesByPath,
  );
  if (targetFile === null) return [];

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
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): readonly ExportConsumer[] {
  const bindings = namespaceImportBindings(sourceFile, sourceFilesByPath);
  if (bindings.size === 0) return [];
  return namespaceMemberUses(sourceFile, bindings);
}

function namespaceImportBindings(
  sourceFile: ts.SourceFile,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): ReadonlyMap<string, NamespaceImportBinding> {
  const bindings = new Map<string, NamespaceImportBinding>();
  for (const statement of sourceFile.statements) {
    addNamespaceImportBinding(bindings, sourceFile.fileName, statement, sourceFilesByPath);
  }
  return bindings;
}

function addNamespaceImportBinding(
  bindings: Map<string, NamespaceImportBinding>,
  fromFile: string,
  statement: ts.Statement,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): void {
  if (!ts.isImportDeclaration(statement)) return;
  const context = importTargetContext(fromFile, statement, sourceFilesByPath);
  const namespaceImport = resolveNamespaceImportFromClause(statement.importClause);
  if (context === null || namespaceImport === null) return;
  bindings.set(namespaceImport.name.text, {
    ...context,
    localName: namespaceImport.name.text,
  });
}

function resolveNamespaceImportFromClause(
  importClause: ts.ImportClause | undefined,
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
    if (consumer !== null) consumers.push(consumer);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return consumers;
}

function namespaceMemberConsumer(
  node: ts.Node,
  bindings: ReadonlyMap<string, NamespaceImportBinding>,
): ExportConsumer | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  if (!ts.isIdentifier(node.expression)) return null;
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

function exportedDeclarationName(statement: ts.Statement): string | null {
  for (const reader of DECLARATION_NAME_READERS) {
    const name = reader(statement);
    if (name !== undefined) return name;
  }
  return null;
}

type DeclarationNameReader = (statement: ts.Statement) => string | null | undefined;

const DECLARATION_NAME_READERS: readonly DeclarationNameReader[] = [
  (statement) => ts.isFunctionDeclaration(statement) ? statement.name?.text ?? null : undefined,
  (statement) => ts.isClassDeclaration(statement) ? statement.name?.text ?? null : undefined,
  (statement) => ts.isInterfaceDeclaration(statement) ? statement.name.text : undefined,
  (statement) => ts.isTypeAliasDeclaration(statement) ? statement.name.text : undefined,
  (statement) => ts.isEnumDeclaration(statement) ? statement.name.text : undefined,
];
