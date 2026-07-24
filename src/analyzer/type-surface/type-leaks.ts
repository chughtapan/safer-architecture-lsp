import ts from "typescript";
import { uniqueDiagnostics } from "../project/api/index.js";
import { publicApiSourceFiles } from "../project/api/index.js";
import type {
  ResolvedArchitectureOptions,
  PackageJson,
  ArchitectureDiagnostic,
  ArchitectureSeverity,
} from "../project/api/index.js";

const MAX_TYPE_DEPTH = 8;

interface TypeVisitContext {
  readonly checker: ts.TypeChecker;
  readonly location: ts.Node;
  readonly visit: (type: ts.Type, depth: number) => void;
}

export function checkPublicVendorTypeLeaks(
  program: ts.Program,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const checker = program.getTypeChecker();
  const diagnostics = publicApiSourceFiles(program, packageJson, options).flatMap(
    (sourceFile) => [
      ...externalReExportDiagnostics(sourceFile, packageJson, options),
      ...exportedSignatureDiagnostics(checker, sourceFile, packageJson, options),
    ],
  );

  return uniqueDiagnostics(diagnostics);
}

function externalReExportDiagnostics(
  sourceFile: ts.SourceFile,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) return [];
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];

    const packageName = publicTypePackageForSpecifier(statement.moduleSpecifier.text, packageJson);
    if (packageName === null || packageAllowedInPublicTypes(packageName, options)) return [];

    return [
      {
        ruleId: "no-public-vendor-type-leak",
        file: sourceFile.fileName,
        severity: publicTypeReExportSeverity(packageName),
        message:
          `Public API re-exports "${packageName}" types from "${statement.moduleSpecifier.text}". ` +
          "Wrap vendor types behind domain-owned public types, or list the package in " +
          "publicTypePackages when it is intentionally part of the contract.",
      },
      ...infraTypeLeakDiagnostic(sourceFile.fileName, packageName, options),
    ];
  });
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".")) return null;
  if (specifier.startsWith("node:")) return "node";

  const [firstSegment, secondSegment] = specifier.split("/");
  if (!firstSegment) return null;
  if (firstSegment.startsWith("@")) {
    return secondSegment ? `${firstSegment}/${secondSegment}` : firstSegment;
  }

  return firstSegment;
}

/**
 * Classify a module specifier for the public-type rules, resolving Node
 * subpath imports (`#`-prefixed) through the package's own `imports`
 * map. A `#` specifier that maps to an in-package path is internal
 * (like a relative import) and returns null; one that maps only to a
 * bare package resolves to that vendor package name. Non-`#` specifiers
 * keep the plain package-name classification.
 */
export function publicTypePackageForSpecifier(
  specifier: string,
  packageJson: Pick<PackageJson, "imports">,
): string | null {
  if (!specifier.startsWith("#")) return packageNameFromSpecifier(specifier);

  const targets = resolveSubpathImportTargets(specifier, packageJson.imports);
  // Any relative target means the specifier resolves inside the package.
  if (targets.some(isInternalImportTarget)) return null;
  for (const target of targets) {
    const vendor = packageNameFromSpecifier(target);
    if (vendor !== null) return vendor;
  }
  // An unmapped or unresolved `#` specifier is never a vendor package.
  return null;
}

function isInternalImportTarget(target: string): boolean {
  return target.startsWith(".") || target.startsWith("#");
}

function resolveSubpathImportTargets(
  specifier: string,
  imports: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const exact = imports.get(specifier);
  if (exact) return exact;

  for (const [key, targets] of imports) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      return targets;
    }
  }
  return [];
}

function packageNameFromFileName(fileName: string): string | null {
  const normalized = fileName.replaceAll("\\", "/");
  if (/\/node_modules\/typescript\/lib\/lib\..+\.d\.ts$/.test(normalized)) return null;

  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return /\/(__generated__|generated)\//.test(normalized) ? "generated-vendor" : null;
  }

  const afterNodeModules = normalized.slice(markerIndex + marker.length);
  const rawPackageName = packageNameFromNodeModulesPath(afterNodeModules);
  return rawPackageName ? normalizeTypePackageName(rawPackageName) : null;
}

function normalizeTypePackageName(packageName: string): string {
  if (!packageName.startsWith("@types/")) return packageName;

  const withoutPrefix = packageName.slice("@types/".length);
  const scopedMatch = /^([^_]+)__([^_]+)$/.exec(withoutPrefix);
  return scopedMatch ? `@${scopedMatch[1]}/${scopedMatch[2]}` : withoutPrefix;
}

export function packageAllowedInPublicTypes(
  packageName: string,
  options: Pick<ResolvedArchitectureOptions, "packageRuntime" | "publicTypePackages">,
): boolean {
  if (options.publicTypePackages.some((entry) => entry.package === packageName)) return true;
  if (packageName !== "node") return false;
  return options.packageRuntime === "node";
}

function exportedSignatureDiagnostics(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];

  return checker.getExportsOfModule(moduleSymbol).flatMap((exportedSymbol) => {
    const declaration = exportedSymbol.valueDeclaration ?? exportedSymbol.declarations?.[0];
    if (!declaration) return [];

    const exportedType = typeForExportedSymbol(checker, exportedSymbol, declaration);
    const leakedPackages = externalPackagesFromType(
      checker,
      exportedType,
      declaration,
      options,
    );

    return [...leakedPackages].flatMap((packageName) => [
      {
        ruleId: "no-public-vendor-type-leak",
        file: sourceFile.fileName,
        severity: publicTypeLeakSeverity(packageName, packageJson),
        message:
          `Public API export "${exportedSymbol.getName()}" references "${packageName}" ` +
          "types. Wrap vendor types behind domain-owned public types, or list the " +
          "package in publicTypePackages when it is intentionally part of the contract.",
      },
      ...infraTypeLeakDiagnostic(sourceFile.fileName, packageName, options),
    ]);
  });
}

function publicTypeLeakSeverity(
  packageName: string,
  packageJson: PackageJson,
): ArchitectureSeverity {
  if (packageName === "node") return "warn";
  return packageJson.peerDependencies.has(packageName) ? "warn" : "error";
}

function publicTypeReExportSeverity(packageName: string): ArchitectureSeverity {
  return packageName === "node" ? "warn" : "error";
}

function infraTypeLeakDiagnostic(
  fileName: string,
  packageName: string,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (!options.infrastructureTypePackages.some((entry) => entry.package === packageName)) return [];

  return [
    {
      ruleId: "no-public-infra-type-leak",
      file: fileName,
      severity: "error",
      message:
        `Public API references infrastructure package "${packageName}". Database, ` +
        "logging, transport, and SDK implementation choices should be hidden behind " +
        "package-owned ports or DTOs.",
    },
  ];
}

function typeForExportedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
): ts.Type {
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    return checker.getDeclaredTypeOfSymbol(symbol);
  }

  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function externalPackagesFromType(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
  options: ResolvedArchitectureOptions,
): ReadonlySet<string> {
  const packages = new Set<string>();
  const seenTypes = new Set<ts.Type>();

  function visit(currentType: ts.Type, depth: number): void {
    if (depth > MAX_TYPE_DEPTH || seenTypes.has(currentType)) return;
    seenTypes.add(currentType);

    const owningPackage = packageNameFromType(currentType);
    if (owningPackage) {
      if (!packageAllowedInPublicTypes(owningPackage, options)) packages.add(owningPackage);
      visitTypeArguments(context, currentType, depth);
      return;
    }

    visitCompositeType(context, currentType, depth);
  }

  const context = { checker, location, visit };
  visit(type, 0);
  return packages;
}

function visitCompositeType(
  context: TypeVisitContext,
  type: ts.Type,
  depth: number,
): void {
  visitUnionMembers(context, type, depth);
  visitTypeArguments(context, type, depth);
  visitSignatures(context, type, depth);
  visitProperties(context, type, depth);
}

function visitUnionMembers(
  context: TypeVisitContext,
  type: ts.Type,
  depth: number,
): void {
  if (!type.isUnionOrIntersection()) return;
  for (const member of type.types) context.visit(member, depth + 1);
}

function visitSignatures(
  context: TypeVisitContext,
  type: ts.Type,
  depth: number,
): void {
  const signatures = [
    ...type.getCallSignatures(),
    ...type.getConstructSignatures(),
  ];
  for (const signature of signatures) visitSignature(context, signature, depth);
}

function visitSignature(
  context: TypeVisitContext,
  signature: ts.Signature,
  depth: number,
): void {
  context.visit(signature.getReturnType(), depth + 1);
  for (const parameter of signature.getParameters()) {
    visitSignatureParameter(context, parameter, depth);
  }
}

function visitSignatureParameter(
  context: TypeVisitContext,
  parameter: ts.Symbol,
  depth: number,
): void {
  const declaration =
    parameter.valueDeclaration ?? parameter.declarations?.[0] ?? context.location;
  context.visit(
    context.checker.getTypeOfSymbolAtLocation(parameter, declaration),
    depth + 1,
  );
}

function visitProperties(
  context: TypeVisitContext,
  type: ts.Type,
  depth: number,
): void {
  for (const property of type.getProperties()) {
    const declaration = property.declarations?.[0];
    if (declaration) {
      context.visit(
        context.checker.getTypeOfSymbolAtLocation(property, declaration),
        depth + 1,
      );
    }
  }
}

function visitTypeArguments(
  context: TypeVisitContext,
  type: ts.Type,
  depth: number,
): void {
  for (const argument of context.checker.getTypeArguments(type as ts.TypeReference)) {
    context.visit(argument, depth + 1);
  }
}

function packageNameFromType(type: ts.Type): string | null {
  const aliasPackage = resolvePackageNameFromSymbol(type.aliasSymbol);
  return aliasPackage ?? resolvePackageNameFromSymbol(type.symbol);
}

function resolvePackageNameFromSymbol(symbol: ts.Symbol | undefined): string | null {
  if (symbol === undefined) return null;
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    const packageName = packageNameFromFileName(declaration.getSourceFile().fileName);
    if (packageName !== null) return packageName;
  }

  return null;
}

function packageNameFromNodeModulesPath(afterNodeModules: string): string | null {
  const [firstSegment, secondSegment] = afterNodeModules.split("/");
  return firstSegment.startsWith("@") && secondSegment
    ? `${firstSegment}/${secondSegment}`
    : firstSegment;
}
