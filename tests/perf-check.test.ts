/**
 * @file Perf-path regressions: the `check` CLI persists and reuses the
 * disk cache across invocations, and the type-leak pre-filter that skips
 * package-local exports never changes which vendor leaks are reported.
 */

import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
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

const BIN = path.resolve("dist/server/index.js");
const REPO_NODE_MODULES = path.resolve("node_modules");

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
  expect(first.status).toBe(0);
  expect(existsSync(cacheFile)).toBe(true);

  const second = spawnSync(process.execPath, [BIN, "check", fixture.root], {
    encoding: "utf8" as const,
  });
  expect(second.status).toBe(0);
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

  expect(ruleIdsFor(fixture.root)).toContain("no-public-vendor-type-leak");
});

it("reports no vendor leak for a pure-local public surface", () => {
  fixture = makeFixture({
    "tsconfig.json": LOCAL_TSCONFIG,
    "package.json": JSON.stringify({ name: "p", exports: { ".": "./index.ts" } }),
    "index.ts":
      "export interface Shape {\n  readonly n: number;\n  readonly kids: ReadonlyArray<Shape>;\n}\nexport const seed: Shape = { n: 0, kids: [] };\n",
  });

  expect(ruleIdsFor(fixture.root)).not.toContain("no-public-vendor-type-leak");
});
