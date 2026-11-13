/**
 * @file End-to-end analyzer tests against on-disk fixture projects:
 * cycle detection fires, clean projects stay quiet, a composition root's
 * imports do not form folder cycles, and exception directives and the
 * `disabledRules` option silence exactly the named rule.
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
  type ArchitectureOptionsInput,
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
const ROOT_INTERNAL_CYCLE_RULE: ArchitectureDiagnosticRuleId = "no-root-internal-cycle";
const PACKAGE_MESH_RULE: ArchitectureDiagnosticRuleId = "no-package-mesh";

/** The reason written into the directive, and the reason its waiver must carry back. */
const SUPPRESSION_REASON = "fixture pins the suppression contract.";

const ALPHA_IMPORTS_BETA =
  'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n';
const BETA_IMPORTS_ALPHA =
  'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n';

/**
 * A process whose `app` folder holds both the file that wires it together
 * (`main.ts`) and settings the `orders` folder reads (`config.ts`). The two
 * folders import each other, but only because the wiring file lives in `app`.
 */
const WIRED_APP_FILES: Readonly<Record<string, string>> = {
  "src/app/main.ts":
    'import { orders } from "../orders/index.js";\nexport const started: number = orders;\n',
  "src/app/config.ts": "export const port: number = 8080;\n",
  "src/orders/index.ts":
    'import { port } from "../app/config.js";\nexport const orders: number = port;\n',
};

/**
 * Domains for the wired-app projects, with the mesh check lowered to their
 * size so its cycle budget is exercised and its density budget never is.
 */
const WIRED_APP_OPTIONS = {
  domains: [
    { name: "app", roots: ["src/app"], entrypoints: ["src/app/config.ts"], reason: "process settings and startup" },
    { name: "orders", roots: ["src/orders"], entrypoints: ["src/orders/index.ts"], reason: "order lifecycle" },
    { name: "billing", roots: ["src/billing"], entrypoints: ["src/billing/index.ts"], reason: "payment lifecycle" },
  ],
  minPackageMeshFolders: 2,
  maxFolderEdgeDensity: 1,
} satisfies ArchitectureOptionsInput;

/**
 * The cycle group the billing fixture wires between two ordinary folders.
 * `app` is absent: it reaches `orders` only through the wiring file.
 */
const EXPECTED_ORDINARY_FOLDER_CYCLE = "Folder dependency cycle: billing <-> orders.";

const MAIN_IS_COMPOSITION_ROOT = {
  ...WIRED_APP_OPTIONS,
  compositionRoots: [{ path: "src/app/main.ts", reason: "process wiring" }],
} satisfies ArchitectureOptionsInput;

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

function ruleIdsFor(
  root: string,
  input: ArchitectureOptionsInput = {},
): readonly string[] {
  const options = resolveArchitectureOptions({ ...input, projectRoot: root });
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

it("does not count a composition root's imports as a folder cycle", () => {
  fixture = makeFixture(WIRED_APP_FILES);
  const ruleIds = ruleIdsFor(fixture.root, MAIN_IS_COMPOSITION_ROOT);
  // `app -> orders` exists only because the wiring file imports what it
  // wires, so neither the cycle rule nor the mesh cycle budget may see it.
  expect(ruleIds).not.toContain(FOLDER_CYCLE_RULE);
  expect(ruleIds).not.toContain(PACKAGE_MESH_RULE);
});

it("reports the same folder cycle when the importing file is not a composition root", () => {
  fixture = makeFixture(WIRED_APP_FILES);
  const ruleIds = ruleIdsFor(fixture.root, WIRED_APP_OPTIONS);
  expect(ruleIds).toContain(FOLDER_CYCLE_RULE);
  expect(ruleIds).toContain(PACKAGE_MESH_RULE);
});

it("still reports a cycle between ordinary folders beside a composition root", () => {
  fixture = makeFixture({
    ...WIRED_APP_FILES,
    "src/orders/total.ts":
      'import { rate } from "../billing/index.js";\nexport const total: number = rate;\n',
    "src/billing/index.ts":
      'import { orders } from "../orders/index.js";\nexport const rate: number = orders;\n',
  });
  const report = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ ...MAIN_IS_COMPOSITION_ROOT, projectRoot: fixture.root }),
  );
  const cycles = report.diagnostics.filter((d) => d.ruleId === FOLDER_CYCLE_RULE);
  // `orders` and `billing` import each other from ordinary modules; `app`
  // joins them only through the wiring file and stays out of the group.
  expect(cycles).toHaveLength(1);
  expect(cycles[0]?.message).toContain(EXPECTED_ORDINARY_FOLDER_CYCLE);
});

it("reports internal code importing back through a composition-root entry", () => {
  fixture = makeFixture({
    "src/index.ts":
      'import { stored } from "./internal/store.js";\nexport const version: number = stored;\n',
    "src/internal/store.ts":
      'import { version } from "../index.js";\nexport const stored: number = version;\n',
  });
  const ruleIds = ruleIdsFor(fixture.root, {
    domains: [{
      name: "internal",
      roots: ["src/internal"],
      entrypoints: ["src/internal/store.ts"],
      reason: "hidden storage decisions",
    }],
    compositionRoots: [{ path: "src/index.ts", reason: "published entry" }],
  });
  // The root entry is the composition root here, so the root/internal check
  // has to read its imports or it could never see this inversion.
  expect(ruleIds).toContain(ROOT_INTERNAL_CYCLE_RULE);
  expect(ruleIds).not.toContain(FOLDER_CYCLE_RULE);
});

it("drops every finding of a rule listed in disabledRules and keeps the rest", () => {
  fixture = makeFixture({
    "alpha/index.ts": ALPHA_IMPORTS_BETA,
    "beta/index.ts": BETA_IMPORTS_ALPHA,
  });
  const report = analyzeResolvedArchitecture(resolveArchitectureOptions({
    projectRoot: fixture.root,
    disabledRules: [{ rule: FOLDER_CYCLE_RULE, reason: "fixture pins the option." }],
  }));
  const ruleIds = report.diagnostics.map((d) => d.ruleId);
  expect(ruleIds).not.toContain(FOLDER_CYCLE_RULE);
  expect(ruleIds).toContain(CROSS_DOMAIN_SIBLING_IMPORT_RULE);
  // The ledger lists comment waivers only; a disabled rule is read from the
  // config file, not from the report.
  expect(report.waivers).toEqual([]);
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
