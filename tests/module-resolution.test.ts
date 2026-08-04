import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "../src/index.js";
import { buildProjectGraph } from "../src/analyzer/imports/project-graph/index.js";
import { emptyPackageJson } from "../src/analyzer/package-api/index.js";
import {
  createProgram,
  projectSourceFiles,
} from "../src/analyzer/project/source-files.js";
import { makeFixture, type Fixture } from "./support/fixtures.js";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

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
  if (program === null) throw new Error("fixture program should compile");

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

  expect(aliasResolutions).toHaveLength(1);
  expect(aliasResolutions[0]?.targetFile).toBe(path.join(fixture.root, "src/core/b.ts"));
  expect(
    analyzeResolvedArchitecture(options).diagnostics.map((diagnostic) => diagnostic.ruleId),
  ).toContain("no-module-cycle");
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
  expect(report.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain(
    "no-module-cycle",
  );
});
