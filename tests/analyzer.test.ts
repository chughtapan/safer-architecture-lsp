/**
 * @file End-to-end analyzer tests against on-disk fixture projects:
 * cycle detection fires, clean projects stay quiet, and exception
 * directives suppress exactly the named rule.
 */

import { FastCheck as fc } from "effect";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ARCHITECTURE_ANALYSIS_UNAVAILABLE_RULE_ID,
} from "../src/analyzer/rule-ids.js";
import {
  analyzeResolvedArchitecture,
  ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  type ArchitectureDiagnosticRuleId,
  resolveArchitectureOptions,
} from "../src/index.js";
import { type Fixture, makeFixture } from "./support/fixtures.js";

/**
 * The rule ids this suite pins, declared against the registry union so a
 * rename in `rule-ids.ts` fails the type-check instead of silently turning
 * these assertions into checks for a rule that no longer exists.
 */
const FOLDER_CYCLE_RULE: ArchitectureDiagnosticRuleId = "no-folder-cycle";
const CROSS_DOMAIN_SIBLING_IMPORT_RULE: ArchitectureDiagnosticRuleId =
  "no-cross-domain-sibling-import";
const MODULE_CYCLE_RULE: ArchitectureDiagnosticRuleId = "no-module-cycle";

/** The reason written into the directive, and the reason its waiver must carry back. */
const SUPPRESSION_REASON = "fixture pins the suppression contract.";

const ALPHA_IMPORTS_BETA =
  'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n';
const BETA_IMPORTS_ALPHA =
  'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n';

/** Every id the registry permits on a diagnostic: real rules plus the two pseudo-rules. */
const REPORTABLE_RULE_IDS: ReadonlySet<string> = new Set<string>([
  ...ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  ARCHITECTURE_ANALYSIS_UNAVAILABLE_RULE_ID,
]);

/**
 * Project shapes spanning the branches the examples below each exercise once:
 * clean, cycle, honored directive, and rejected directive.
 */
const PROJECT_SHAPES: ReadonlyArray<Readonly<Record<string, string>>> = [
  { "core/index.ts": "export const answer: number = 42;\n" },
  { "alpha/index.ts": ALPHA_IMPORTS_BETA, "beta/index.ts": BETA_IMPORTS_ALPHA },
  {
    "alpha/index.ts":
      `// safer-arch-ignore ${FOLDER_CYCLE_RULE}: ${SUPPRESSION_REASON}\n` +
      ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  },
  {
    "alpha/index.ts":
      "// safer-arch-ignore not-a-real-rule: because.\n" + ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  },
];

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function ruleIdsFor(root: string): readonly string[] {
  const options = resolveArchitectureOptions({ projectRoot: root });
  return analyzeResolvedArchitecture(options).diagnostics.map((d) => d.ruleId);
}

it("reports folder cycles and cross-domain sibling imports", () => {
  fixture = makeFixture({
    "alpha/index.ts": ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  });
  const ruleIds = ruleIdsFor(fixture.root);
  // Two folders importing each other is both a folder cycle and, because
  // neither folder owns the other, a sibling import across domain lines.
  expect(ruleIds).toContain(FOLDER_CYCLE_RULE);
  expect(ruleIds).toContain(CROSS_DOMAIN_SIBLING_IMPORT_RULE);
});

it("reports nothing for an acyclic single-owner project", () => {
  fixture = makeFixture({
    "core/index.ts": "export const answer: number = 42;\n",
  });
  expect(ruleIdsFor(fixture.root)).toEqual([]);
});

it("reports a deterministic module SCC and canonical cycle", () => {
  fixture = makeFixture({
    "c.ts": 'import { a } from "./a.js";\nexport const c: number = a + 1;\n',
    "a.ts":
      'import { c } from "./c.js";\n' +
      'import { b } from "./b.js";\n' +
      "export const a: number = b + c;\n",
    "b.ts": 'import { a } from "./a.js";\nexport const b: number = a + 1;\n',
  });

  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const diagnostics = analyzeResolvedArchitecture(options).diagnostics.filter(
    (diagnostic) => diagnostic.ruleId === MODULE_CYCLE_RULE,
  );

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.file.endsWith("/a.ts")).toBe(true);
  expect(diagnostics[0]?.message).toContain(
    "Module dependency component (3): a.ts, b.ts, c.ts. " +
      "Canonical cycle: a.ts -> b.ts -> a.ts.",
  );
});

it("suppresses a diagnostic via a reason-carrying safer-arch-ignore directive and records the waiver", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      `// safer-arch-ignore ${FOLDER_CYCLE_RULE}: ${SUPPRESSION_REASON}\n` +
      ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  });
  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const report = analyzeResolvedArchitecture(options);
  const alphaCycleFindings = report.diagnostics.filter(
    (d) => d.ruleId === FOLDER_CYCLE_RULE && d.file.includes("alpha"),
  );
  expect(alphaCycleFindings).toEqual([]);
  expect(report.diagnostics.map((d) => d.ruleId)).not.toContain(
    ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  );
  const waiver = report.waivers.find(
    (w) => w.ruleId === FOLDER_CYCLE_RULE && w.file.includes("alpha"),
  );
  // The ledger must reproduce the directive's written reason verbatim; a
  // trimmed or re-worded reason would break the audit trail it exists for.
  expect(waiver?.reason).toBe(SUPPRESSION_REASON);
});

it("reports a parse error for a directive missing its reason", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      `// safer-arch-ignore ${FOLDER_CYCLE_RULE}:\n` + ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  });
  expect(ruleIdsFor(fixture.root)).toContain(
    ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  );
});

it("reports a parse error for an unknown rule id", () => {
  fixture = makeFixture({
    "core/index.ts":
      "// safer-arch-ignore not-a-real-rule: because.\nexport const answer: number = 42;\n",
  });
  expect(ruleIdsFor(fixture.root)).toContain(
    ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID,
  );
});

it("tombstones the legacy directive marker instead of honoring it", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      `// @agent-code-guard/architecture-exception: ${FOLDER_CYCLE_RULE}\n` +
      "// reason: legacy two-line form must not suppress anything.\n" +
      ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  });
  const ruleIds = ruleIdsFor(fixture.root);
  expect(ruleIds).toContain(ARCHITECTURE_DIRECTIVE_PARSE_ERROR_RULE_ID);
  expect(ruleIds).toContain(FOLDER_CYCLE_RULE);
});

it("keeps the rule registry and the waiver ledger honest for every project shape", () => {
  fc.assert(
    fc.property(fc.constantFrom(...PROJECT_SHAPES), (files) => {
      const project = makeFixture(files);
      try {
        const report = analyzeResolvedArchitecture(
          resolveArchitectureOptions({ projectRoot: project.root }),
        );
        for (const diagnostic of report.diagnostics) {
          // An id outside the registry could never be waived, because the
          // directive parser validates written ids against that same list.
          expect(REPORTABLE_RULE_IDS.has(diagnostic.ruleId)).toBe(true);
          // Editors and CI resolve the reported path against nothing, so a
          // relative path would attach the finding to the wrong file.
          expect(path.isAbsolute(diagnostic.file)).toBe(true);
        }
        for (const waiver of report.waivers) {
          const stillReported = report.diagnostics.filter(
            (d) =>
              d.ruleId === waiver.ruleId &&
              path.resolve(d.file) === path.resolve(waiver.file),
          );
          // A ledger entry claims that file's finding for that rule was dropped;
          // a surviving diagnostic for the same pair would make the claim a lie.
          expect(stillReported).toEqual([]);
        }
      } finally {
        project.cleanup();
      }
    }),
    // Every run builds a real project on disk and compiles it, so the budget
    // stays close to the case count; each shape is also pinned by its own
    // example above.
    { numRuns: PROJECT_SHAPES.length * 3 },
  );
});
