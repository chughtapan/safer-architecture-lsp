/**
 * @file Per-rule documentation links. Every rule anchors into the
 * package-owned reference at docs/rules.md, whose heading slugs are the
 * rule ids themselves, so the href is derivable and cannot drift.
 */

import type { ArchitectureRuleId } from "../index.js";


// safer-arch-ignore no-trivial-sink-file: rule-docs owns the docs-URL contract; folding it into the converter would hide where deep links come from.
const RULE_DOCS_BASE =
  "https://github.com/chughtapan/safer-architecture-lsp/blob/main/docs/rules.md";

const FALLBACK_CODE_DESCRIPTION: { readonly href: string } = Object.freeze({
  href: RULE_DOCS_BASE,
});

const cache = new Map<string, { readonly href: string }>();

/**
 * `codeDescription` for `ruleId`. Returns a shared frozen object.
 * @param ruleId Used verbatim as the heading anchor in docs/rules.md; an
 * empty id degrades to the top of that page instead of a dead anchor.
 * @returns Cached link object, shared by every diagnostic of this rule.
 */
export function ruleCodeDescription(
  ruleId: string,
): { readonly href: string } {
  if (ruleId.length === 0) {return FALLBACK_CODE_DESCRIPTION;}
  let entry = cache.get(ruleId);
  if (entry === undefined) {
    entry = Object.freeze({
      href: `${RULE_DOCS_BASE}#${
        // The anchor is the rule id verbatim, and an unknown id is a dead
        // anchor on a real page rather than a type-level failure, so safe.
        ruleId as ArchitectureRuleId
      }`,
    });
    cache.set(ruleId, entry);
  }
  return entry;
}
