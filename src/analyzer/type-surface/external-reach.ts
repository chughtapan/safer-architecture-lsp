import path from "node:path";
import ts from "typescript";
import { projectSourceFiles } from "../project/api/index.js";
import type {
  ProjectArchitectureGraph,
  SourceModule,
} from "../project/index.js";

interface FileReach {
  readonly hasExternal: boolean;
  readonly edges: readonly ts.SourceFile[];
}

/**
 * Memoized predicate over a project's source files: can any type a file
 * declares reach a symbol outside the package? It is a conservative
 * fast path: only files whose complete known local-import closure has no
 * external statement edge or non-statement module reference answer
 * false and skip the deep semantic type walk.
 *
 * `externalPackageForSpecifier` returns the external package name for a
 * bare or subpath-external specifier, or null for a package-internal one.
 * The canonical project graph supplies statement import/re-export edges;
 * targeted syntax scanning covers constructs that graph intentionally
 * does not model. Files outside the project SourceFile identity set
 * always answer true — a vendor re-export must never be skipped.
 */
export function buildExternalTypeReach(
  program: ts.Program,
  graph: ProjectArchitectureGraph,
  externalPackageForSpecifier: (specifier: string) => string | null,
): (declarationFile: ts.SourceFile) => boolean {
  // Ambient globals (e.g. `@types/node`'s `Buffer`) leak into a type
  // without any import, so the import closure cannot prove a file safe:
  // fall back to walking every export.
  if (hasUntrackedAmbientGlobals(program)) return () => true;

  const projectFiles = projectSourceFiles(program, graph.projectRoot);
  const checker = program.getTypeChecker();
  const projectFileSet = new Set(projectFiles);
  const byPath = new Map(
    projectFiles.map((file) => [path.resolve(file.fileName), file] as const),
  );

  const scanned = new Map<ts.SourceFile, FileReach>();
  for (const file of projectFiles) {
    const module = graph.modulesByFileName.get(path.resolve(file.fileName));
    scanned.set(
      file,
      module === undefined
        ? { hasExternal: true, edges: [] }
        : graphFileReach(
            file,
            module,
            byPath,
            checker,
            externalPackageForSpecifier,
          ),
    );
  }

  const reachesExternal = markReachesExternal(projectFiles, scanned);
  return (declarationFile) =>
    !projectFileSet.has(declarationFile) || reachesExternal.has(declarationFile);
}

/**
 * Seed every file that imports something external, then propagate the
 * mark backwards along relative-import edges to a fixpoint. Reverse
 * multi-source reachability is cycle-safe, unlike depth-first memoization
 * with an on-stack guard.
 */
function markReachesExternal(
  projectFiles: readonly ts.SourceFile[],
  scanned: ReadonlyMap<ts.SourceFile, FileReach>,
): ReadonlySet<ts.SourceFile> {
  const importers = new Map<ts.SourceFile, ts.SourceFile[]>();
  for (const file of projectFiles) {
    for (const target of scanned.get(file)?.edges ?? []) {
      const list = importers.get(target);
      if (list) list.push(file);
      else importers.set(target, [file]);
    }
  }

  const marked = new Set<ts.SourceFile>();
  const queue: ts.SourceFile[] = [];
  for (const file of projectFiles) {
    if (scanned.get(file)?.hasExternal) {
      marked.add(file);
      queue.push(file);
    }
  }
  while (queue.length > 0) {
    const target = queue.pop() as ts.SourceFile;
    for (const importer of importers.get(target) ?? []) {
      if (marked.has(importer)) continue;
      marked.add(importer);
      queue.push(importer);
    }
  }
  return marked;
}

/**
 * Whether the program contains globals that are visible without a
 * module edge. This includes script files, `declare global`
 * augmentations, and UMD `export as namespace` declarations. Any one of
 * them defeats a per-file import-closure proof, so disable the fast path
 * for the whole Program.
 */
function hasUntrackedAmbientGlobals(program: ts.Program): boolean {
  for (const sourceFile of program.getSourceFiles()) {
    if (
      program.isSourceFileDefaultLibrary(sourceFile) &&
      isBuiltInTypeScriptLib(sourceFile.fileName)
    ) {
      continue;
    }
    if (!ts.isExternalModule(sourceFile)) return true;
    if (containsGlobalAugmentation(sourceFile)) return true;
    // A module augmentation can merge vendor-owned members into a
    // declaration in another file without creating a graph edge back to
    // that declaration. Its target is semantic, so any augmentation
    // anywhere in the Program invalidates the per-file proof.
    if (containsStringLiteralModuleDeclaration(sourceFile)) return true;
  }
  return false;
}

function isBuiltInTypeScriptLib(fileName: string): boolean {
  const normalized = fileName.replaceAll("\\", "/");
  return /\/node_modules\/typescript\/lib\/lib\..+\.d\.ts$/.test(normalized);
}

function containsGlobalAugmentation(sourceFile: ts.SourceFile): boolean {
  return statementsContainGlobalAugmentation(sourceFile.statements);
}

function statementsContainGlobalAugmentation(
  statements: readonly ts.Statement[],
): boolean {
  for (const statement of statements) {
    if (ts.isNamespaceExportDeclaration(statement)) return true;
    if (!ts.isModuleDeclaration(statement)) continue;
    if ((statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0) return true;

    let body = statement.body;
    while (body && ts.isModuleDeclaration(body)) {
      if ((body.flags & ts.NodeFlags.GlobalAugmentation) !== 0) return true;
      body = body.body;
    }
    if (
      body &&
      ts.isModuleBlock(body) &&
      statementsContainGlobalAugmentation(body.statements)
    ) {
      return true;
    }
  }
  return false;
}

function graphFileReach(
  file: ts.SourceFile,
  module: SourceModule,
  byPath: ReadonlyMap<string, ts.SourceFile>,
  checker: ts.TypeChecker,
  externalPackageForSpecifier: (specifier: string) => string | null,
): FileReach {
  const edges: ts.SourceFile[] = [];
  let hasExternal =
    hasNonStatementModuleReference(file) ||
    hasUncertainStatementModuleReference(file, module, checker);

  for (const edge of module.localEdges) {
    // Classify the raw specifier rather than trusting the graph's generic
    // package name so `#` imports retain public-type-rule precision.
    if (externalPackageForSpecifier(edge.specifier) !== null) {
      hasExternal = true;
      continue;
    }

    const target = byPath.get(edge.to);
    if (target) edges.push(target);
    // If the canonical edge cannot be joined back to this Program, its
    // closure is uncertain. Force the full semantic walk.
    else hasExternal = true;
  }

  for (const edge of module.externalEdges) {
    if (externalPackageForSpecifier(edge.specifier) !== null) {
      hasExternal = true;
      continue;
    }

    // The generic graph records `#` specifiers as external, while the
    // public-type classifier can prove that some map back into this
    // package. Recover those checker-resolved project targets so internal
    // `#` edges retain the same reverse-reachability precision as relative
    // graph edges. Any missing or out-of-project target is uncertainty.
    const checkerTargets = checkerTargetsForSpecifier(
      file,
      edge.specifier,
      checker,
    );
    if (checkerTargets === null) {
      hasExternal = true;
      continue;
    }
    for (const checkerTarget of checkerTargets) {
      const target = byPath.get(checkerTarget);
      if (target) edges.push(target);
      else hasExternal = true;
    }
  }

  return { hasExternal, edges };
}

/**
 * The canonical graph deliberately contains statement-level
 * import/re-export edges only. These syntax forms can also introduce a
 * checker-visible external type, so their presence conservatively
 * forces the semantic walk. This also covers relative and `#` forms:
 * without a canonical edge for them, their transitive closure cannot be
 * proven package-local.
 */
function hasNonStatementModuleReference(file: ts.SourceFile): boolean {
  if (
    isJavaScriptSourceFile(file) ||
    file.languageVariant === ts.LanguageVariant.JSX ||
    file.amdDependencies.length > 0 ||
    file.typeReferenceDirectives.length > 0 ||
    file.referencedFiles.length > 0 ||
    file.libReferenceDirectives.length > 0
  ) {
    return true;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const jsDocTags = ts.getJSDocTags(node);
    if (jsDocTags.some((tag) => ts.isJSDocImportTag(tag))) {
      found = true;
      return;
    }

    const jsDocType = ts.getJSDocType(node);
    if (jsDocType) {
      visit(jsDocType);
      if (found) return;
    }
    const jsDocReturnType = ts.getJSDocReturnType(node);
    if (jsDocReturnType) {
      visit(jsDocReturnType);
      if (found) return;
    }
    for (const tag of jsDocTags) {
      visit(tag);
      if (found) return;
    }

    if (ts.isImportTypeNode(node)) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      found = true;
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      found = true;
      return;
    }
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isJavaScriptSourceFile(file: ts.SourceFile): boolean {
  const extension = path.extname(file.fileName).toLowerCase();
  return (
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".mjs" ||
    extension === ".cjs"
  );
}

/**
 * Validate that every statement import/re-export shape is represented in
 * the canonical graph. The graph intentionally drops unresolved relative
 * and malformed specifiers; those are not proof of a package-local
 * closure, so they must conservatively force the semantic walk. Resolution
 * itself remains owned by the graph.
 */
function hasUncertainStatementModuleReference(
  file: ts.SourceFile,
  module: SourceModule,
  checker: ts.TypeChecker,
): boolean {
  const representedSpecifiers = new Set([
    ...module.localEdges.map((edge) => edge.specifier),
    ...module.externalEdges.map((edge) => edge.specifier),
  ]);
  const localTargetsBySpecifier = new Map<string, Set<string>>();
  for (const edge of module.localEdges) {
    const targets = localTargetsBySpecifier.get(edge.specifier) ?? new Set();
    targets.add(path.resolve(edge.to));
    localTargetsBySpecifier.set(edge.specifier, targets);
  }

  for (const statement of file.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
        ? statement.moduleSpecifier
        : undefined;
    if (moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(moduleSpecifier)) return true;
    if (!representedSpecifiers.has(moduleSpecifier.text)) return true;

    const graphTargets = localTargetsBySpecifier.get(moduleSpecifier.text);
    if (
      graphTargets !== undefined &&
      !moduleSpecifierMatchesGraphTarget(moduleSpecifier, graphTargets, checker)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The canonical graph owns statement resolution, but its deliberately
 * small path resolver can disagree with TypeScript when extension
 * substitution, moduleSuffixes, or rootDirs are in play. Such a mismatch
 * invalidates the graph as a proof of locality, so fail open.
 */
function moduleSpecifierMatchesGraphTarget(
  moduleSpecifier: ts.StringLiteral,
  graphTargets: ReadonlySet<string>,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(moduleSpecifier);
  if (!symbol?.declarations?.length) return false;

  const checkerTargets = new Set(
    symbol.declarations.map((declaration) =>
      path.resolve(declaration.getSourceFile().fileName)
    ),
  );
  if (checkerTargets.size !== graphTargets.size) return false;
  for (const target of checkerTargets) {
    if (!graphTargets.has(target)) return false;
  }
  return true;
}

function checkerTargetsForSpecifier(
  file: ts.SourceFile,
  specifier: string,
  checker: ts.TypeChecker,
): ReadonlySet<string> | null {
  const targets = new Set<string>();
  let found = false;

  for (const statement of file.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
        ? statement.moduleSpecifier
        : undefined;
    if (
      moduleSpecifier === undefined ||
      !ts.isStringLiteral(moduleSpecifier) ||
      moduleSpecifier.text !== specifier
    ) {
      continue;
    }

    found = true;
    const symbol = checker.getSymbolAtLocation(moduleSpecifier);
    if (!symbol?.declarations?.length) return null;
    for (const declaration of symbol.declarations) {
      targets.add(path.resolve(declaration.getSourceFile().fileName));
    }
  }

  return found && targets.size > 0 ? targets : null;
}

function containsStringLiteralModuleDeclaration(file: ts.SourceFile): boolean {
  return statementsContainStringLiteralModuleDeclaration(file.statements);
}

function statementsContainStringLiteralModuleDeclaration(
  statements: readonly ts.Statement[],
): boolean {
  for (const statement of statements) {
    if (!ts.isModuleDeclaration(statement)) continue;
    if (ts.isStringLiteral(statement.name)) return true;

    let body = statement.body;
    while (body && ts.isModuleDeclaration(body)) {
      if (ts.isStringLiteral(body.name)) return true;
      body = body.body;
    }
    if (
      body &&
      ts.isModuleBlock(body) &&
      statementsContainStringLiteralModuleDeclaration(body.statements)
    ) {
      return true;
    }
  }
  return false;
}
