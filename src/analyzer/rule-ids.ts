// Single source of truth for architecture rule identifiers. Imported by the
// rule registry, the diagnostic-emission cache, and the directive parser so
// the list cannot drift between them.

export const ARCHITECTURE_DIAGNOSTIC_RULE_IDS = [
  "no-inventory-barrel",
  "no-internal-subpath-export",
  "no-public-vendor-type-leak",
  "no-export-star-boundary",
  "no-folder-cycle",
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

export type ArchitectureDiagnosticRuleId =
  (typeof ARCHITECTURE_DIAGNOSTIC_RULE_IDS)[number];

// A pseudo-rule used only to surface malformed `@agent-code-guard/architecture-exception:`
// directive comments. It is reported alongside any architecture rule that
// could legitimately fire, so users always see the parse error regardless of
// which rules they have enabled.
export const ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID =
  "architecture-directive-parse-error" as const;

export type ArchitectureRuleId =
  | ArchitectureDiagnosticRuleId
  | typeof ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID;
