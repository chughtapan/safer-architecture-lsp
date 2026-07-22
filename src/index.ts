/**
 * @file Public API barrel. Exposes the analyzer entry point, the
 * architecture options schema surface, the rule-id registry, and the
 * diagnostic types — everything a programmatic consumer (CI shim,
 * custom tooling) needs without reaching into internal modules. The
 * LSP server ships separately as the `safer-architecture-lsp` bin.
 */

export { analyzeResolvedArchitecture } from "./analyzer/index.js";
export {
  ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  type ArchitectureRuleId,
} from "./analyzer/rule-ids.js";
export {
  resolveArchitectureOptions,
  type ArchitectureOptionsInput,
} from "./analyzer/project/api/index.js";
export type {
  ArchitectureDiagnostic,
  ArchitectureDiagnosticRuleId,
  ArchitectureReport,
  ArchitectureSeverity,
  LayerDefinition,
  ResolvedArchitectureOptions,
} from "./analyzer/project/api/index.js";
