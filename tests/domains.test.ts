import { afterEach, expect, it } from "vitest";
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
  type ArchitectureOptionsInput,
} from "../src/index.js";
import { makeFixture, type Fixture } from "./support/fixtures.js";

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
  const ownership = report.diagnostics.filter(({ ruleId }) => ruleId === "require-domain-ownership");
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
  expect(ids).toContain("no-domain-cycle");
  expect(ids).toContain("no-domain-boundary-bypass");
  expect(ids).toContain("no-cross-domain-side-effect");
  expect(ids.filter((ruleId) => ruleId === "no-cross-domain-side-effect")).toHaveLength(2);
  expect(report.diagnostics.find(({ ruleId }) => ruleId === "no-domain-cycle")?.message)
    .toContain("billing -> orders -> billing");
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
