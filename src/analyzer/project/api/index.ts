/**
 * @file Project-API barrel. Re-exports the architecture options
 * schema, diagnostic types, project source-file collection, and rule
 * helpers used by every architecture analysis pass.
 */

export {
  resolveArchitectureOptions,
  type ArchitectureOptionsInput,
} from "../config.js";
export {
  SOURCE_EXTENSIONS,
  candidateFileNames,
  stripKnownExtension,
} from "../source-paths.js";
export {
  createProgram,
  findPackageReportFile,
  programHealth,
  projectSourceFiles,
  publicApiSourceFiles,
} from "../source-files.js";
export type { ProgramHealth } from "../source-files.js";
export { collectPackageExportEntries } from "../package-exports/index.js";
export { emptyPackageJson, readPackageJson } from "../package-json.js";
export { uniqueDiagnostics } from "../diagnostics/index.js";
export type {
  ArchitectureDiagnostic,
  ArchitectureDiagnosticRuleId,
  ArchitectureReport,
  ArchitectureWaiver,
  ArchitectureSeverity,
  LayerDefinition,
  PackageExportEntry,
  PackageJson,
  ResolvedArchitectureOptions,
} from "../diagnostics/index.js";
