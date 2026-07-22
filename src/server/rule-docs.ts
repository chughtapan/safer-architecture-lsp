/**
 * @file Per-rule PRINCIPLES.md anchors. URLs pin to `main` so the
 * anchor resolves against the current heading text; the slug follows
 * GitHub's heading-to-anchor algorithm (lowercase, spaces and dots
 * to hyphens, drop other non-alphanumeric).
 */

import type { ArchitectureRuleId } from "../analyzer/rule-ids.js";

const PRINCIPLES_BASE =
  "https://github.com/chughtapan/safer-by-default/blob/main/PRINCIPLES.md";

/** PRINCIPLES.md anchor for each architecture rule. */
const ARCHITECTURE_RULE_ANCHORS: Readonly<Record<ArchitectureRuleId, string>> = {
  "no-inventory-barrel": "#5-discipline-over-capability",
  "no-internal-subpath-export": "#5-discipline-over-capability",
  "no-public-vendor-type-leak": "#2-validate-at-every-boundary--schemas-where-data-enters-types-inside",
  "no-export-star-boundary": "#5-discipline-over-capability",
  "no-folder-cycle": "#8-the-ratchet--escalate-up-not-around",
  "no-root-internal-cycle": "#8-the-ratchet--escalate-up-not-around",
  "no-large-public-surface": "#6-the-budget-gate--scope-is-a-hard-budget",
  "no-cross-domain-sibling-import": "#8-the-ratchet--escalate-up-not-around",
  "no-upward-layer-import": "#8-the-ratchet--escalate-up-not-around",
  "no-public-test-helper-leak": "#5-discipline-over-capability",
  "no-implementation-file-public-entry": "#5-discipline-over-capability",
  "no-public-infra-type-leak": "#2-validate-at-every-boundary--schemas-where-data-enters-types-inside",
  "no-package-mesh": "#8-the-ratchet--escalate-up-not-around",
  "no-large-folder": "#6-the-budget-gate--scope-is-a-hard-budget",
  "folder-readme-required": "#5-discipline-over-capability",
  "no-distant-folder-import": "#8-the-ratchet--escalate-up-not-around",
  "require-curated-public-facade": "#5-discipline-over-capability",
  "require-boundary-owned-types": "#2-validate-at-every-boundary--schemas-where-data-enters-types-inside",
  "folder-explicit-api-required": "#6-the-budget-gate--scope-is-a-hard-budget",
  "file-implicit-boundary-module": "#6-the-budget-gate--scope-is-a-hard-budget",
  "shared-kernel-cohesion": "#5-discipline-over-capability",
  "no-trivial-sink-file": "#5-discipline-over-capability",
  "no-fat-orchestrator": "#5-discipline-over-capability",
  "architecture-directive-parse-error": "#5-discipline-over-capability",
};

const FALLBACK_CODE_DESCRIPTION: { readonly href: string } = Object.freeze({
  href: PRINCIPLES_BASE,
});

/** Pre-built frozen `codeDescription` per rule id. */
const ARCHITECTURE_RULE_CODE_DESCRIPTIONS: Readonly<
  Record<ArchitectureRuleId, { readonly href: string }>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(ARCHITECTURE_RULE_ANCHORS).map(([id, anchor]) => [
      id,
      Object.freeze({ href: `${PRINCIPLES_BASE}${anchor}` }),
    ]),
  ) as Record<ArchitectureRuleId, { readonly href: string }>,
);

/** `codeDescription` for `ruleId`. Returns a shared frozen object. */
export function ruleCodeDescription(
  ruleId: string,
): { readonly href: string } {
  return (
    ARCHITECTURE_RULE_CODE_DESCRIPTIONS[ruleId as ArchitectureRuleId] ??
    FALLBACK_CODE_DESCRIPTION
  );
}
