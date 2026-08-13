/**
 * @file Public API barrel. Exposes the analyzer entry point, the
 * architecture options schema surface, the rule-id registry, and the
 * diagnostic types — everything a programmatic consumer (CI shim,
 * custom tooling) needs without reaching into internal modules. The
 * LSP server ships separately as the `safer-architecture-lsp` bin.
 */
// safer-arch-ignore no-folder-cycle: project API type barrels intentionally share diagnostic and source-model types; splitting these type-only contracts would duplicate the public vocabulary.
// safer-arch-ignore no-package-mesh: the analyzer is one domain with specialized passes behind a single API; folder count reflects rule families, not independently coupled packages.

/**
 * The one-shot analysis call. A consumer that already resolved its options
 * runs the whole rule set through this and gets a finished report back.
 */
export { analyzeResolvedArchitecture } from "./analyzer/index.js";
/**
 * Options handling for callers that hold raw config. Decoding is exposed
 * separately from analysis so a host can validate a config file without
 * paying for a TypeScript program.
 */
export {
  type ArchitectureOptionsInput,
  resolveArchitectureOptions,
} from "./analyzer/project/api/index.js";
/**
 * The report vocabulary: what a diagnostic, a waiver, and the resolved
 * options look like, plus the domain and layer shapes a config declares.
 */
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
/**
 * The rule-id registry, so a consumer can enumerate the enforceable rules and
 * recognize the parse-error pseudo-rule that no waiver can silence.
 */
export {
  ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  type ArchitectureRuleId,
} from "./analyzer/rule-ids.js";
