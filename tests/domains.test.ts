/**
 * @file End-to-end checks for the domain layer: which files a domain owns,
 * which imports cross a domain boundary, and which entrypoint configurations
 * are rejected outright. Every case runs the real analyzer over a throwaway
 * on-disk project rather than a hand-assembled graph.
 */

import { afterEach, expect, it } from "vitest";
import {
  analyzeResolvedArchitecture,
  type ArchitectureDiagnosticRuleId,
  type ArchitectureOptionsInput,
  resolveArchitectureOptions,
} from "../src/index.js";
import { type Fixture, makeFixture } from "./support/fixtures.js";

/**
 * The domain rule ids this suite pins, declared against the registry union so
 * a rename in `rule-ids.ts` fails the type-check rather than leaving these
 * assertions looking for a rule that no longer exists.
 */
const DOMAIN_CYCLE_RULE: ArchitectureDiagnosticRuleId = "no-domain-cycle";
const DOMAIN_BOUNDARY_BYPASS_RULE: ArchitectureDiagnosticRuleId =
  "no-domain-boundary-bypass";
const CROSS_DOMAIN_SIDE_EFFECT_RULE: ArchitectureDiagnosticRuleId =
  "no-cross-domain-side-effect";
const DOMAIN_OWNERSHIP_RULE: ArchitectureDiagnosticRuleId =
  "require-domain-ownership";

/**
 * The cycle the fixture below wires: billing's entrypoint imports orders'
 * entrypoint, orders reaches back into billing. Rendered from the smallest
 * domain name so the path is stable whichever domain is visited first.
 */
const EXPECTED_DOMAIN_CYCLE_PATH = "billing -> orders -> billing";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const domainOptions = {
  domains: [
    {
      name: "orders",
      roots: ["src/orders"],
      entrypoints: ["src/orders/index.ts"],
      reason: "order lifecycle",
    },
    {
      name: "billing",
      roots: ["src/billing"],
      entrypoints: ["src/billing/index.ts"],
      reason: "payment lifecycle",
    },
  ],
  domainOwnership: [
    { path: "src/legacy", domain: "orders", reason: "migration is owned by orders" },
  ],
  compositionRoots: [
    { path: "src/bootstrap.ts", reason: "application wiring edge" },
  ],
} satisfies ArchitectureOptionsInput;

it("infers and overrides ownership while exempting composition roots", () => {
  fixture = makeFixture({
    "src/orders/index.ts": "export const orders = 1;\n",
    "src/billing/index.ts": "export const billing = 1;\n",
    "src/legacy/adapter.ts": "export const legacy = 1;\n",
    "src/bootstrap.ts":
      'import "./orders/index.js";\nimport "./billing/index.js";\nexport const started = true;\n',
    "src/unowned.ts": "export const loose = 1;\n",
  });
  const report = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ ...domainOptions, projectRoot: fixture.root }),
  );
  const ownership = report.diagnostics.filter(({ ruleId }) => ruleId === DOMAIN_OWNERSHIP_RULE);
  // Only `src/unowned.ts` is unclaimed: the two domain roots own their files,
  // the override hands `src/legacy` to orders, and a composition root is exempt.
  expect(ownership).toHaveLength(1);
  expect(ownership[0]?.file.endsWith("/src/unowned.ts")).toBe(true);
});

it("reports domain SCCs, boundary bypasses, and cross-domain side effects", () => {
  fixture = makeFixture({
    "src/orders/index.ts":
      'import { charge } from "../billing/internal.js";\nexport const orders = charge;\n',
    "src/orders/register.ts":
      'import "../billing/register.js";\nexport const registered = true;\n',
    "src/orders/empty-register.ts":
      'import {} from "../billing/empty.js";\nexport const emptyRegistered = true;\n',
    "src/billing/index.ts":
      'import { orders } from "../orders/index.js";\nexport const billing = orders;\n',
    "src/billing/internal.ts": "export const charge = 1;\n",
    "src/billing/register.ts": "export const installed = true;\n",
    "src/billing/empty.ts": "export const emptyInstalled = true;\n",
  });
  const report = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ ...domainOptions, projectRoot: fixture.root }),
  );
  const ids = report.diagnostics.map(({ ruleId }) => ruleId);
  // The two entrypoints import each other (cycle), orders reaches past
  // billing's entrypoint into `internal.ts` (bypass), and the two bare
  // `import "..."` statements cross the boundary for their side effects only.
  expect(ids).toContain(DOMAIN_CYCLE_RULE);
  expect(ids).toContain(DOMAIN_BOUNDARY_BYPASS_RULE);
  expect(ids).toContain(CROSS_DOMAIN_SIDE_EFFECT_RULE);
  // Both the bare import and the empty-named import count: an empty import
  // list still runs the imported module for its effects.
  expect(ids.filter((ruleId) => ruleId === CROSS_DOMAIN_SIDE_EFFECT_RULE)).toHaveLength(2);
  expect(report.diagnostics.find(({ ruleId }) => ruleId === DOMAIN_CYCLE_RULE)?.message)
    .toContain(EXPECTED_DOMAIN_CYCLE_PATH);
});

it("rejects entrypoints outside their domain roots", () => {
  expect(() => resolveArchitectureOptions({
    domains: [{
      name: "orders",
      roots: ["src/orders"],
      entrypoints: ["src/public.ts"],
      reason: "orders",
    }],
  })).toThrow("outside its configured roots");
});
