// safer-arch-ignore no-folder-cycle: project API type barrels intentionally share diagnostic and source-model types; splitting these type-only contracts would duplicate the public vocabulary.
// safer-arch-ignore no-package-mesh: the analyzer is one domain with specialized passes behind a single API; folder count reflects rule families, not independently coupled packages.
/**
 * @file Public API barrel. Exposes the analyzer entry point, the
 * architecture options schema surface, the rule-id registry, and the
 * diagnostic types — everything a programmatic consumer (CI shim,
 * custom tooling) needs without reaching into internal modules. The
 * LSP server ships separately as the `safer-architecture-lsp` bin.
 */

export { analyzeResolvedArchitecture } from "./analyzer/index.js";
export {
  type ArchitectureOptionsInput,
  resolveArchitectureOptions,
} from "./analyzer/project/api/index.js";
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
  ResolvedArchitectureOptions,
} from "./analyzer/project/api/index.js";
export {
  ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  type ArchitectureRuleId,
} from "./analyzer/rule-ids.js";
