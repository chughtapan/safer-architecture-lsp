/**
 * @file Per-rule documentation links. Every rule anchors into the
 * package-owned reference at docs/rules.md, whose heading slugs are the
 * rule ids themselves, so the href is derivable and cannot drift.
 */

import type { ArchitectureRuleId } from "../analyzer/rule-ids.js";

const RULE_DOCS_BASE =
  "https://github.com/chughtapan/safer-architecture-lsp/blob/main/docs/rules.md";

const FALLBACK_CODE_DESCRIPTION: { readonly href: string } = Object.freeze({
  href: RULE_DOCS_BASE,
});

const cache = new Map<string, { readonly href: string }>();

/** `codeDescription` for `ruleId`. Returns a shared frozen object. */
export function ruleCodeDescription(
  ruleId: string,
): { readonly href: string } {
  if (ruleId.length === 0) return FALLBACK_CODE_DESCRIPTION;
  let entry = cache.get(ruleId);
  if (entry === undefined) {
    entry = Object.freeze({ href: `${RULE_DOCS_BASE}#${ruleId as ArchitectureRuleId}` });
    cache.set(ruleId, entry);
  }
  return entry;
}
