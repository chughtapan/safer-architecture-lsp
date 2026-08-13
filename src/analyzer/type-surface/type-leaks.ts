/**
 * @file Public-API vendor type-leak checks. Reports exports and
 * re-exports whose types resolve into a package the contract does not
 * declare public, and raises a second diagnostic when that package is
 * configured as infrastructure.
 */

import ts from "typescript";
import type { ProjectArchitectureGraph } from "../project/index.js";
import {
  type ArchitectureDiagnostic,
  type ArchitectureSeverity,
  type PackageJson,
  publicApiSourceFiles, type ResolvedArchitectureOptions , uniqueDiagnostics 
} from "../project/api/index.js";
import { buildExternalTypeReach } from "./external-reach.js";

const MAX_TYPE_DEPTH = 8;

interface TypeVisitContext {
  readonly checker: ts.TypeChecker;
  readonly location: ts.Node;
  readonly visit: (type: ts.Type, depth: number) => void;
}

/**
 * Report every public-API re-export or exported signature whose type
 * reaches a package that is not allowed in public types. Files that
 * cannot reach anything outside the package are skipped before the deep
 * type walk, and resolved types are shared across the public files.
 * @param program Supplies the checker and the set of public-API files.
 * @param graph Backs the reachability fast path that skips files with a
 * package-local import closure.
 * @param packageJson Decides which specifiers name a vendor package, and
 * downgrades a peer dependency's leak to a warning.
 * @param options Public and infrastructure package lists plus the
 * declared package runtime.
 * @returns Deduplicated diagnostics; empty when no public type names a
 * disallowed package.
 */
export function checkPublicVendorTypeLeaks(
  program: ts.Program,
  graph: ProjectArchitectureGraph,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  const checker = program.getTypeChecker();
  const exportedTypePackages = new Map<ts.Type, ReadonlySet<string>>();
  const mayReachExternal = buildExternalTypeReach(program, graph, (specifier) =>
    publicTypePackageForSpecifier(specifier, packageJson),
  );
  const diagnostics = publicApiSourceFiles(program, packageJson, options).flatMap(
    (sourceFile) => [
      ...externalReExportDiagnostics(sourceFile, packageJson, options),
      ...exportedSignatureDiagnostics(
        checker,
        sourceFile,
        packageJson,
        options,
        mayReachExternal,
        exportedTypePackages,
      ),
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
    if (!ts.isExportDeclaration(statement)) {return [];}
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {return [];}

    const packageName = publicTypePackageForSpecifier(statement.moduleSpecifier.text, packageJson);
    if (packageName === null || packageAllowedInPublicTypes(packageName, options)) {return [];}

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
  if (specifier.startsWith(".")) {return null;}
  if (specifier.startsWith("node:")) {return "node";}

  const [firstSegment, secondSegment] = specifier.split("/");
  if (!firstSegment) {return null;}
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
 * @param specifier Module specifier exactly as written in the source, not
 * the graph's already-classified package name.
 * @param packageJson Read only for its `imports` map, which is what turns
 * a `#` specifier into concrete targets.
 * @returns The vendor package the specifier belongs to, or null when it
 * resolves inside this package.
 */
export function publicTypePackageForSpecifier(
  specifier: string,
  packageJson: Pick<PackageJson, "imports">,
): string | null {
  if (!specifier.startsWith("#")) {return packageNameFromSpecifier(specifier);}

  const targets = resolveSubpathImportTargets(specifier, packageJson.imports);
  // Any relative target means the specifier resolves inside the package.
  if (targets.some(isInternalImportTarget)) {return null;}
  for (const target of targets) {
    const vendor = packageNameFromSpecifier(target);
    if (vendor !== null) {return vendor;}
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
  if (exact) {return exact;}

  for (const [key, targets] of imports) {
    const star = key.indexOf("*");
    if (star === -1) {continue;}
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
  if (/\/node_modules\/typescript\/lib\/lib\..+\.d\.ts$/.test(normalized)) {return null;}

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
  if (!packageName.startsWith("@types/")) {return packageName;}

  const withoutPrefix = packageName.slice("@types/".length);
  const scopedMatch = /^([^_]+)__([^_]+)$/.exec(withoutPrefix);
  return scopedMatch ? `@${scopedMatch[1]}/${scopedMatch[2]}` : withoutPrefix;
}

/**
 * Whether a package may appear in the public type surface. Node's own
 * types are tolerated for a node-runtime package without being listed;
 * every other package has to be declared explicitly, so a new vendor
 * dependency cannot enter the contract by accident.
 * @param packageName Vendor package name as classified from a specifier
 * or from a declaring file under `node_modules`.
 * @param options Carries the declared public-type packages and the
 * runtime the package targets.
 * @returns True when the package is part of the published contract.
 */
export function packageAllowedInPublicTypes(
  packageName: string,
  options: Pick<ResolvedArchitectureOptions, "packageRuntime" | "publicTypePackages">,
): boolean {
  if (options.publicTypePackages.some((entry) => entry.package === packageName)) {return true;}
  if (packageName !== "node") {return false;}
  return options.packageRuntime === "node";
}

function exportedSignatureDiagnostics(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
  mayReachExternal: (declarationFile: ts.SourceFile) => boolean,
  exportedTypePackages: Map<ts.Type, ReadonlySet<string>>,
): readonly ArchitectureDiagnostic[] {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {return [];}

  return checker.getExportsOfModule(moduleSymbol).flatMap((exportedSymbol) => {
    const declaration = exportedSymbol.valueDeclaration ?? exportedSymbol.declarations?.[0];
    if (!declaration) {return [];}
    // An export whose declaring file cannot reach any external import
    // has an entirely package-local type: skip the deep walk that would
    // otherwise fully resolve it.
    if (!mayReachExternal(declaration.getSourceFile())) {return [];}

    const exportedType = typeForExportedSymbol(checker, exportedSymbol, declaration);
    const leakedPackages = externalPackagesFromType(
      checker,
      exportedType,
      declaration,
      options,
      exportedTypePackages,
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
  if (packageName === "node") {return "warn";}
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
  if (!options.infrastructureTypePackages.some((entry) => entry.package === packageName)) {return [];}

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
  exportedTypePackages: Map<ts.Type, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = exportedTypePackages.get(type);
  if (cached !== undefined) {return cached;}

  const packages = new Set<string>();
  const seenTypes = new Set<ts.Type>();
  const context: TypeVisitContext = { checker, location, visit };

  function visit(currentType: ts.Type, depth: number): void {
    if (depth > MAX_TYPE_DEPTH || seenTypes.has(currentType)) {return;}
    seenTypes.add(currentType);

    const owningPackage = packageNameFromType(currentType);
    if (owningPackage) {
      if (!packageAllowedInPublicTypes(owningPackage, options)) {packages.add(owningPackage);}
      visitTypeArguments(context, currentType, depth);
      return;
    }

    visitCompositeType(context, currentType, depth);
  }

  visit(type, 0);
  exportedTypePackages.set(type, packages);
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
  if (!type.isUnionOrIntersection()) {return;}
  for (const member of type.types) {context.visit(member, depth + 1);}
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
  for (const signature of signatures) {visitSignature(context, signature, depth);}
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
  const typeArguments = context.checker.getTypeArguments(
    // The checker reads reference-only fields lazily, so the assertion is
    // safe: a type that is not a reference yields an empty argument list.
    type as ts.TypeReference,
  );
  for (const argument of typeArguments) {
    context.visit(argument, depth + 1);
  }
}

function packageNameFromType(type: ts.Type): string | null {
  const aliasPackage = resolvePackageNameFromSymbol(type.aliasSymbol);
  return aliasPackage ?? resolvePackageNameFromSymbol(type.symbol);
}

function resolvePackageNameFromSymbol(symbol?: ts.Symbol): string | null {
  if (symbol === undefined) {return null;}
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    const packageName = packageNameFromFileName(declaration.getSourceFile().fileName);
    if (packageName !== null) {return packageName;}
  }

  return null;
}

function packageNameFromNodeModulesPath(afterNodeModules: string): string | null {
  const [firstSegment, secondSegment] = afterNodeModules.split("/");
  return firstSegment.startsWith("@") && secondSegment
    ? `${firstSegment}/${secondSegment}`
    : firstSegment;
}
