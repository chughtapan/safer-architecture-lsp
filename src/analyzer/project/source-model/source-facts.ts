/**
 * @file Syntactic facts read straight off a path string or a top-level
 * statement. Nothing here consults the type checker or resolves a
 * specifier, so the import-graph builder can classify a file before any
 * module resolution has happened.
 */

import ts from "typescript";

/**
 * Decide whether a file belongs to the test tree rather than the shipped
 * source. Architecture rules exempt these, so both the `.test`/`.spec`
 * naming convention and test/fixture directory segments count.
 * @param fileName Path to classify; separators are normalized first so
 * Windows paths match the same patterns.
 * @returns True when the path names a test, fixture, or test-support file.
 */
export function isTestLikePath(fileName: string): boolean {
  const normalized = normalizePath(fileName);
  return (
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalized) ||
    /(^|\/)(__tests__|tests?|testing|test-utils|test-support|fixtures?|__fixtures__)(\/|$)/.test(
      normalized,
    )
  );
}

/**
 * Recognize an unrestricted re-export (`export * from "..."`), which
 * widens a facade's public surface without naming what it exposes.
 * @param statement Top-level statement to inspect.
 * @returns True for an export declaration carrying no export clause.
 */
export function isStarExportDeclaration(statement: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(statement) &&
    statement.exportClause === undefined
  );
}

/**
 * Decide whether a declaration is part of its module's public surface by
 * looking for the `export` keyword on it.
 * @param statement Top-level statement to inspect.
 * @returns True when the statement can carry modifiers and one of them
 * is `export`.
 */
export function hasExportModifier(statement: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

/**
 * Read the single name a declaration introduces, so exported symbols can
 * be counted and matched by name.
 * @param statement Top-level statement to read a name from.
 * @returns The declared identifier, or null when the statement declares
 * nothing nameable — a destructuring pattern, or a kind of declaration
 * outside the supported set.
 */
export function exportedDeclarationName(statement: ts.Statement): string | null {
  if (ts.isVariableStatement(statement)) {return variableStatementName(statement);}
  return nonVariableDeclarationName(statement);
}

/**
 * Rewrite a path to forward slashes. Every path comparison and regex in
 * the analyzer assumes this form, so Windows paths are folded here once
 * instead of at each comparison site.
 * @param pathLike Path or path fragment in either separator style.
 * @returns The same path with `\\` replaced by `/`.
 */
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
    if (name !== undefined) {return name;}
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
