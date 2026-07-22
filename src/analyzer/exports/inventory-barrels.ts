import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SOURCE_EXTENSIONS, stripKnownExtension } from "../project/api/index.js";
import type { ResolvedArchitectureOptions, ArchitectureDiagnostic } from "../project/api/index.js";

export function checkInventoryBarrels(
  sourceFiles: readonly ts.SourceFile[],
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return sourceFiles.flatMap((sourceFile) =>
    inventoryBarrelDiagnostic(sourceFile, options),
  );
}

function inventoryBarrelDiagnostic(
  sourceFile: ts.SourceFile,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (!isIndexSourceFile(sourceFile.fileName)) return [];

  const eligibleSiblingModules = eligibleSiblingModuleKeys(path.dirname(sourceFile.fileName));
  const exportedEligibleSiblingModules = intersectSets(
    exportedSiblingModuleKeys(sourceFile, options),
    eligibleSiblingModules,
  );
  const exportedCount = exportedEligibleSiblingModules.size;
  const eligibleCount = eligibleSiblingModules.size;

  if (eligibleCount === 0) return [];
  if (exportedCount < options.minExportedSiblingModules) return [];
  if (exportedCount / eligibleCount < options.maxExportedSiblingRatio) return [];

  return [
    {
      ruleId: "no-inventory-barrel",
      file: sourceFile.fileName,
      severity: "warn",
      message:
        `${path.relative(options.projectRoot, sourceFile.fileName)} exports ` +
        `${exportedCount} of ${eligibleCount} eligible sibling modules. ` +
        "This exports inventory, not an abstraction. Export a smaller facade: " +
        "ports, factories, and stable types only.",
    },
  ];
}

function isIndexSourceFile(fileName: string): boolean {
  const parsed = path.parse(fileName);
  return (
    parsed.name === "index" &&
    SOURCE_EXTENSIONS.some((extension) => parsed.ext === extension)
  );
}

function eligibleSiblingModuleKeys(directory: string): ReadonlySet<string> {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const keys = new Set<string>();

  for (const entry of entries) {
    const moduleKey = eligibleSiblingEntryKey(directory, entry);
    if (moduleKey !== null) keys.add(moduleKey);
  }

  return keys;
}

function eligibleSiblingEntryKey(
  directory: string,
  entry: fs.Dirent,
): string | null {
  if (entry.name.startsWith(".")) return null;
  if (!entry.isDirectory()) return sourceModuleKey(entry.name);
  return directoryHasIndexSource(path.join(directory, entry.name))
    ? entry.name
    : null;
}

function directoryHasIndexSource(directory: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) =>
    fs.existsSync(path.join(directory, `index${extension}`)),
  );
}

function sourceModuleKey(fileName: string): string | null {
  if (isExcludedSourceFile(fileName)) return null;

  const extension = SOURCE_EXTENSIONS.find((candidate) => fileName.endsWith(candidate));
  return extension ? fileName.slice(0, -extension.length) : null;
}

function isExcludedSourceFile(fileName: string): boolean {
  return (
    fileName.startsWith("index.") ||
    fileName.endsWith(".d.ts") ||
    /\.(test|spec|stories)\.[cm]?[tj]sx?$/.test(fileName) ||
    /\.generated\.[cm]?[tj]sx?$/.test(fileName)
  );
}

function exportedSiblingModuleKeys(
  sourceFile: ts.SourceFile,
  options: Pick<ResolvedArchitectureOptions, "countTypeOnlyExports">,
): ReadonlySet<string> {
  const keys = new Set<string>();

  for (const statement of sourceFile.statements) {
    const moduleKey = exportedSiblingModuleKey(statement, options);
    if (moduleKey !== null) keys.add(moduleKey);
  }

  return keys;
}

function exportedSiblingModuleKey(
  statement: ts.Statement,
  options: Pick<ResolvedArchitectureOptions, "countTypeOnlyExports">,
): string | null {
  if (!ts.isExportDeclaration(statement)) return null;
  if (!options.countTypeOnlyExports && exportDeclarationIsTypeOnly(statement)) return null;
  const moduleSpecifier = statement.moduleSpecifier;
  if (moduleSpecifier === undefined) return null;
  if (!ts.isStringLiteral(moduleSpecifier)) return null;
  return siblingModuleKeyFromSpecifier(moduleSpecifier.text);
}

function exportDeclarationIsTypeOnly(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return true;
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return false;
  return statement.exportClause.elements.every((specifier) => specifier.isTypeOnly);
}

function siblingModuleKeyFromSpecifier(specifier: string): string | null {
  if (!specifier.startsWith("./")) return null;

  const segments = stripKnownExtension(specifier.slice(2))
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length === 1) return segments[0] === "index" ? null : segments[0] ?? null;
  if (segments.length === 2 && segments[1] === "index") return segments[0] ?? null;
  return null;
}

function intersectSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): ReadonlySet<T> {
  return new Set([...left].filter((value) => right.has(value)));
}
