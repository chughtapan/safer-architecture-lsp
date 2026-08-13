/**
 * @file Project-API barrel. Re-exports the architecture options
 * schema, diagnostic types, project source-file collection, and rule
 * helpers used by every architecture analysis pass.
 */

export {
  type ArchitectureOptionsInput,
  resolveArchitectureOptions,
} from "../config.js";
export { uniqueDiagnostics } from "../diagnostics/index.js";
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
export { collectPackageExportEntries } from "../package-exports/index.js";
export { emptyPackageJson, readPackageJson } from "../package-json.js";
export {
  createProgram,
  findPackageReportFile,
  programHealth,
  projectSourceFiles,
  publicApiSourceFiles,
} from "../source-files.js";
export {
  candidateFileNames,
  SOURCE_EXTENSIONS,
  stripKnownExtension,
} from "../source-paths.js";
