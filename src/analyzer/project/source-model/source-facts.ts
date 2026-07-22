import ts from "typescript";

export function isTestLikePath(fileName: string): boolean {
  const normalized = normalizePath(fileName);
  return (
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalized) ||
    /(^|\/)(__tests__|tests?|testing|test-utils|test-support|fixtures?|__fixtures__)(\/|$)/.test(
      normalized,
    )
  );
}

export function isStarExportDeclaration(statement: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(statement) &&
    statement.exportClause === undefined
  );
}

export function hasExportModifier(statement: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

export function exportedDeclarationName(statement: ts.Statement): string | null {
  if (ts.isVariableStatement(statement)) return variableStatementName(statement);
  return nonVariableDeclarationName(statement);
}

export function normalizePath(pathLike: string): string {
  return pathLike.replaceAll("\\", "/");
}

function variableStatementName(statement: ts.VariableStatement): string | null {
  for (const declaration of statement.declarationList.declarations) {
    const name = declaration.name;
    return ts.isIdentifier(name) ? name.text : null;
  }
  return null;
}

function nonVariableDeclarationName(statement: ts.Statement): string | null {
  for (const reader of NON_VARIABLE_DECLARATION_NAME_READERS) {
    const name = reader(statement);
    if (name !== undefined) return name;
  }
  return null;
}

type DeclarationNameReader = (statement: ts.Statement) => string | null | undefined;

const NON_VARIABLE_DECLARATION_NAME_READERS: readonly DeclarationNameReader[] = [
  (statement) => ts.isFunctionDeclaration(statement) ? statement.name?.text ?? null : undefined,
  (statement) => ts.isClassDeclaration(statement) ? statement.name?.text ?? null : undefined,
  (statement) => ts.isInterfaceDeclaration(statement) ? statement.name.text : undefined,
  (statement) => ts.isTypeAliasDeclaration(statement) ? statement.name.text : undefined,
  (statement) => ts.isEnumDeclaration(statement) ? statement.name.text : undefined,
];
