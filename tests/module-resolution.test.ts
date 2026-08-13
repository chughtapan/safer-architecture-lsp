/**
 * @file Checks that the import graph follows the same module resolution
 * TypeScript itself performs. Both tsconfig path aliases and package.json
 * subpath imports must land on local files, so a cycle hidden behind an
 * alias is still reported as a cycle.
 */

import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProjectGraph } from "../src/analyzer/imports/project-graph/index.js";
import { emptyPackageJson } from "../src/analyzer/package-api/index.js";
import {
  createProgram,
  projectSourceFiles,
} from "../src/analyzer/project/source-files.js";
import {
  analyzeResolvedArchitecture,
  type ArchitectureDiagnosticRuleId,
  resolveArchitectureOptions,
} from "../src/index.js";
import { type Fixture, makeFixture } from "./support/fixtures.js";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** The rule a two-file import cycle must surface, whatever specifier form hid it. */
const MODULE_CYCLE_RULE: ArchitectureDiagnosticRuleId = "no-module-cycle";

/** One alias resolution is expected per distinct aliased specifier in the fixture. */
const EXPECTED_ALIAS_RESOLUTIONS = 1;

const ALIAS_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    baseUrl: ".",
    paths: { "@core/*": ["src/core/*"] },
  },
  include: ["src/**/*.ts"],
});

it("resolves tsconfig paths through one cached TypeScript snapshot", () => {
  fixture = makeFixture({
    "tsconfig.json": ALIAS_TSCONFIG,
    "src/core/a.ts":
      'import { b } from "@core/b";\n' +
      'import type { B } from "@core/b";\n' +
      "export const a: B = b;\n",
    "src/core/b.ts":
      'import { a } from "./a.js";\n' +
      "export type B = number;\n" +
      "export const b: B = a + 1;\n",
  });
  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const program = createProgram(options);
  if (program === null) {throw new Error("fixture program should compile");}

  const graph = buildProjectGraph(
    projectSourceFiles(program, fixture.root),
    emptyPackageJson(),
    options,
    path.join(fixture.root, "package.json"),
    program.getCompilerOptions(),
  );
  const aliasResolutions = graph.moduleResolutions.filter(
    (entry) => entry.specifier === "@core/b",
  );

  expect(aliasResolutions).toHaveLength(EXPECTED_ALIAS_RESOLUTIONS);
  expect(aliasResolutions[0]?.targetFile).toBe(path.join(fixture.root, "src/core/b.ts"));
  // a.ts and b.ts import each other, one leg through the `@core/*` alias; the
  // alias must resolve to the local file or the cycle would stay invisible.
  expect(
    analyzeResolvedArchitecture(options).diagnostics.map((diagnostic) => diagnostic.ruleId),
  ).toContain(MODULE_CYCLE_RULE);
});

it("classifies a package imports alias as a local module edge", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "fixture-package",
      type: "module",
      imports: { "#a": "./src/a.ts" },
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }),
    "src/a.ts":
      'import { b } from "./b.js";\n' +
      "export const a: number = b + 1;\n",
    "src/b.ts":
      'import { a } from "#a";\n' +
      "export const b: number = a + 1;\n",
  });

  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const report = analyzeResolvedArchitecture(options);
  // b.ts reaches a.ts through the `#a` subpath import while a.ts imports b.ts
  // directly; classifying `#a` as a local edge is what closes the cycle.
  expect(report.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain(
    MODULE_CYCLE_RULE,
  );
});
