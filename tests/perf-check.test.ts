/**
 * @file Perf-path regressions: the `check` CLI persists and reuses the
 * disk cache across invocations, and the type-leak pre-filter that skips
 * package-local exports never changes which vendor leaks are reported.
 */

import * as fc from "effect/FastCheck";
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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

const BIN = path.resolve("dist/server/index.js");
const REPO_NODE_MODULES = path.resolve("node_modules");

/** The rule the import-closure pre-filter must never cause to be missed. */
const VENDOR_TYPE_LEAK_RULE: ArchitectureDiagnosticRuleId = "no-public-vendor-type-leak";

/** `check` exits 0 only when the run completed and found nothing. */
const EXIT_CLEAN = 0;

/** Entrypoint counts the shared-walk property sweeps over. */
const MIN_ENTRYPOINTS = 1;
const MAX_ENTRYPOINTS = 3;

function byFileName(left: string, right: string): number {
  return left.localeCompare(right);
}

const LOCAL_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    // types:[] keeps `@types/node` globals out, so the import-closure
    // pre-filter stays active (no ambient globals to defeat it).
    types: [],
  },
  include: ["**/*.ts"],
});

function ruleIdsFor(root: string): readonly string[] {
  return analyzeResolvedArchitecture(
    resolveArchitectureOptions({ projectRoot: root }),
  ).diagnostics.map((d) => d.ruleId);
}

it("persists a disk cache across `check` invocations and hits it on repeat", () => {
  fixture = makeFixture({ "core/index.ts": "export const answer: number = 42;\n" });
  const cacheFile = path.join(
    fixture.root,
    "node_modules",
    ".cache",
    "safer-architecture-lsp",
    "report.json",
  );
  expect(existsSync(cacheFile)).toBe(false);

  const first = spawnSync(process.execPath, [BIN, "check", fixture.root], {
    encoding: "utf8" as const,
  });
  expect(first.status).toBe(EXIT_CLEAN);
  // The first run must leave the cache behind, or the second run has nothing
  // to hit and the perf path silently degrades to a full re-analysis.
  expect(existsSync(cacheFile)).toBe(true);

  const second = spawnSync(process.execPath, [BIN, "check", fixture.root], {
    encoding: "utf8" as const,
  });
  expect(second.status).toBe(EXIT_CLEAN);
  // A cache hit has to produce byte-identical output: reuse that changes the
  // report is a correctness bug wearing a performance costume.
  expect(second.stdout).toBe(first.stdout);
});

it("still flags a public vendor type leak when the pre-filter is active", () => {
  fixture = makeFixture({
    "tsconfig.json": LOCAL_TSCONFIG,
    "package.json": JSON.stringify({ name: "p", exports: { ".": "./index.ts" } }),
    "index.ts":
      'import { Effect } from "effect";\nexport function run(): Effect.Effect<number> {\n  return Effect.succeed(1);\n}\n',
    "local/util.ts": "export const helper = (n: number): number => n + 1;\n",
  });
  symlinkSync(REPO_NODE_MODULES, path.join(fixture.root, "node_modules"), "dir");

  // `run` returns an Effect type from a public entrypoint while `local/util.ts`
  // stays package-local: the pre-filter may skip the local file but must still
  // walk the entrypoint, so the vendor leak has to be reported.
  expect(ruleIdsFor(fixture.root)).toContain(VENDOR_TYPE_LEAK_RULE);
});

it("reuses an exported type walk across public entrypoints without dropping findings", () => {
  fixture = makeFixture({
    "tsconfig.json": LOCAL_TSCONFIG,
    "package.json": JSON.stringify({
      name: "p",
      exports: {
        ".": "./index.ts",
        "./secondary": "./secondary.ts",
      },
    }),
    "index.ts": 'export { run } from "./shared.js";\n',
    "secondary.ts": 'export { run } from "./shared.js";\n',
    "shared.ts":
      'import { Effect } from "effect";\n' +
      "export function run(): Effect.Effect<number> {\n" +
      "  return Effect.succeed(1);\n" +
      "}\n",
  });
  symlinkSync(REPO_NODE_MODULES, path.join(fixture.root, "node_modules"), "dir");

  const diagnostics = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ projectRoot: fixture.root }),
  ).diagnostics.filter((diagnostic) => diagnostic.ruleId === VENDOR_TYPE_LEAK_RULE);

  // Both entrypoints re-export the same vendor-typed symbol. Caching the type
  // walk after the first entrypoint must not swallow the second one's finding,
  // so each public file is reported on its own.
  expect(
    diagnostics.map((diagnostic) => path.basename(diagnostic.file)).sort(byFileName),
  ).toEqual(["index.ts", "secondary.ts"]);
});

it("reports no vendor leak for a pure-local public surface", () => {
  fixture = makeFixture({
    "tsconfig.json": LOCAL_TSCONFIG,
    "package.json": JSON.stringify({ name: "p", exports: { ".": "./index.ts" } }),
    "index.ts":
      "export interface Shape {\n  readonly n: number;\n  readonly kids: ReadonlyArray<Shape>;\n}\nexport const seed: Shape = { n: 0, kids: [] };\n",
  });

  // Nothing on this public surface comes from a package: `Shape` is self-
  // referential but package-owned, so the pre-filter's skip is a true negative.
  expect(ruleIdsFor(fixture.root)).not.toContain(VENDOR_TYPE_LEAK_RULE);
});

/**
 * The example above pins the shared type walk at exactly two entrypoints. The
 * invariant is that reuse never drops a finding at any fan-out: however many
 * public entrypoints re-export the same vendor-typed symbol, every one of them
 * is reported, so the walk cache can speed the analysis but not shrink it.
 */
it("reports every public entrypoint that shares a vendor-typed symbol, at any fan-out", () => {
  fc.assert(
    fc.property(fc.integer({ min: MIN_ENTRYPOINTS, max: MAX_ENTRYPOINTS }), (entrypoints) => {
      const project = makeFixture(sharedVendorTypeProject(entrypoints));
      symlinkSync(REPO_NODE_MODULES, path.join(project.root, "node_modules"), "dir");
      try {
        const leaks = analyzeResolvedArchitecture(
          resolveArchitectureOptions({ projectRoot: project.root }),
        ).diagnostics.filter((diagnostic) => diagnostic.ruleId === VENDOR_TYPE_LEAK_RULE);
        expect(
          leaks.map((diagnostic) => path.basename(diagnostic.file)).sort(byFileName),
        ).toEqual(entrypointFileNames(entrypoints));
      } finally {
        project.cleanup();
      }
    }),
    { numRuns: 5 },
  );
});

/**
 * Build a package whose public entrypoints all re-export one vendor-typed
 * function from a shared implementation module.
 * @param entrypoints How many public entrypoint files to publish.
 * @returns Fixture files for `makeFixture`.
 */
function sharedVendorTypeProject(entrypoints: number): Readonly<Record<string, string>> {
  const names = entrypointFileNames(entrypoints);
  const reExport = 'export { run } from "./shared.js";\n';
  const files: Record<string, string> = {
    "tsconfig.json": LOCAL_TSCONFIG,
    "package.json": JSON.stringify({
      name: "p",
      exports: Object.fromEntries(
        names.map((name) => [name === "index.ts" ? "." : `./${path.parse(name).name}`, `./${name}`]),
      ),
    }),
    "shared.ts":
      'import { Effect } from "effect";\n' +
      "export function run(): Effect.Effect<number> {\n" +
      "  return Effect.succeed(1);\n" +
      "}\n",
  };
  for (const name of names) {files[name] = reExport;}
  return files;
}

/**
 * File names of the public entrypoints, in the order `byFileName` sorts them.
 * @param entrypoints How many entrypoint files the package publishes.
 * @returns `index.ts` plus one numbered entry file per extra entrypoint.
 */
function entrypointFileNames(entrypoints: number): readonly string[] {
  const names = ["index.ts"];
  for (let index = 1; index < entrypoints; index += 1) {
    names.push(`entry${index}.ts`);
  }
  return names.sort(byFileName);
}
