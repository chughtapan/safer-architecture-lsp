/**
 * @file Single source of truth for architecture rule identifiers. The rule
 * registry, the diagnostic-emission cache, and the directive parser all read
 * the list from here, so a rule added or renamed in one of them cannot drift
 * out of step with the other two.
 */

/**
 * Every rule id the analyzer can report as an ordinary diagnostic. Frozen as a
 * literal tuple because it doubles as the runtime allow-list a
 * `safer-arch-ignore` directive is validated against.
 */
export const ARCHITECTURE_DIAGNOSTIC_RULE_IDS = [
  "no-inventory-barrel",
  "no-internal-subpath-export",
  "no-public-vendor-type-leak",
  "no-export-star-boundary",
  "no-folder-cycle",
  "no-module-cycle",
  "no-workspace-package-cycle",
  "require-domain-ownership",
  "no-domain-cycle",
  "no-domain-boundary-bypass",
  "no-cross-domain-side-effect",
  "no-root-internal-cycle",
  "no-large-public-surface",
  "no-cross-domain-sibling-import",
  "no-upward-layer-import",
  "no-public-test-helper-leak",
  "no-implementation-file-public-entry",
  "no-public-infra-type-leak",
  "no-package-mesh",
  "no-large-folder",
  "folder-readme-required",
  "no-distant-folder-import",
  "require-curated-public-facade",
  "require-boundary-owned-types",
  "folder-explicit-api-required",
  "file-implicit-boundary-module",
  "shared-kernel-cohesion",
  "no-trivial-sink-file",
  "no-fat-orchestrator",
] as const;

/**
 * A rule the user can enable, waive, and see reported against a file. The two
 * pseudo-rules below are deliberately outside this union so they cannot be
 * suppressed by a directive.
 */
export type ArchitectureDiagnosticRuleId =
  (typeof ARCHITECTURE_DIAGNOSTIC_RULE_IDS)[number];

/**
 * A pseudo-rule used only to surface malformed `safer-arch-ignore` directive
 * comments and tombstoned legacy markers. It is reported alongside any
 * architecture rule that could legitimately fire, so users always see the
 * parse error regardless of which rules they have enabled.
 */
export const ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID =
  "architecture-directive-parse-error";

/**
 * A pseudo-rule that reports "analysis did not run" for a missing or broken
 * tsconfig or a crashed engine. A guardrail must never present a state it
 * could not analyze as an empty, clean report.
 */
export const ARCHITECTURE_ANALYSIS_UNAVAILABLE_RULE_ID =
  "architecture-analysis-unavailable";

/**
 * Every id that can reach a consumer on a diagnostic, real rules plus the two
 * pseudo-rules that report a broken directive and a run that never happened.
 */
export type ArchitectureRuleId =
  | ArchitectureDiagnosticRuleId
  | typeof ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID
  | typeof ARCHITECTURE_ANALYSIS_UNAVAILABLE_RULE_ID;
