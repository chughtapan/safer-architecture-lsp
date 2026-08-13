/**
 * @file Project-API barrel. Re-exports the architecture options
 * schema, diagnostic types, project source-file collection, and rule
 * helpers used by every architecture analysis pass.
 */

/** Raw option decoding and the defaulting that produces resolved options. */
export {
  type ArchitectureOptionsInput,
  resolveArchitectureOptions,
} from "../config.js";
/** Collapses findings that several passes reported identically. */
export { uniqueDiagnostics } from "../diagnostics/index.js";
/** Result and configuration shapes every analysis pass reads or returns. */
export type {
  ArchitectureAnalysisSnapshot,
  ArchitectureDiagnostic,
  ArchitectureDiagnosticRuleId,
  ArchitectureReport,
  ArchitectureSeverity,
  ArchitectureWaiver,
  CompositionRoot,
  DomainDefinition,
  DomainOwnership,
  LayerDefinition,
  PackageExportEntry,
  PackageJson,
  ResolvedArchitectureOptions,
} from "../diagnostics/index.js";
/** Flattens the `exports` tree into the public paths a package really exposes. */
export { collectPackageExportEntries } from "../package-exports/index.js";
/** Reads `package.json`, plus the empty stand-in used when there is none. */
export { emptyPackageJson, readPackageJson } from "../package-json.js";
/**
 * TypeScript program construction and the file selection built on it:
 * which files the project owns, which are public, and why a program
 * could not be built.
 */
export {
  createProgram,
  findPackageReportFile,
  programHealth,
  projectSourceFiles,
  publicApiSourceFiles,
} from "../source-files.js";
/** Extension handling for matching a specifier against files on disk. */
export {
  candidateFileNames,
  SOURCE_EXTENSIONS,
  stripKnownExtension,
} from "../source-paths.js";
