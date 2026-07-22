/**
 * @file End-to-end analyzer tests against on-disk fixture projects:
 * cycle detection fires, clean projects stay quiet, and exception
 * directives suppress exactly the named rule.
 */

import { afterEach, expect, it } from "vitest";
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "../dist/index.js";
import { makeFixture, type Fixture } from "./support/fixtures.js";

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
    "alpha/index.ts":
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const ruleIds = ruleIdsFor(fixture.root);
  expect(ruleIds).toContain("no-folder-cycle");
  expect(ruleIds).toContain("no-cross-domain-sibling-import");
});

it("reports nothing for an acyclic single-owner project", () => {
  fixture = makeFixture({
    "core/index.ts": "export const answer: number = 42;\n",
  });
  expect(ruleIdsFor(fixture.root)).toEqual([]);
});

it("suppresses a diagnostic via a reason-carrying exception directive", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      "// @agent-code-guard/architecture-exception: no-folder-cycle\n" +
      "// reason: fixture pins the suppression contract for this rule.\n" +
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const diagnostics = analyzeResolvedArchitecture(options).diagnostics;
  const alphaCycleFindings = diagnostics.filter(
    (d) => d.ruleId === "no-folder-cycle" && d.file.includes("alpha"),
  );
  expect(alphaCycleFindings).toEqual([]);
  expect(diagnostics.map((d) => d.ruleId)).not.toContain(
    "architecture-directive-parse-error",
  );
});

it("reports a parse error for a directive missing its reason line", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      "// @agent-code-guard/architecture-exception: no-folder-cycle\n" +
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  expect(ruleIdsFor(fixture.root)).toContain("architecture-directive-parse-error");
});
