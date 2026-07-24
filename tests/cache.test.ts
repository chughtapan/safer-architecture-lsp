/**
 * @file Cache regressions: the analyzer-version watermark must resolve
 * the real package version (the src/ restructure once broke the relative
 * walk and every cache read silently fell back), and a stale disk-cache
 * refresh must not hash every source file twice.
 */

import fs, { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
// eslint-disable-next-line import/no-relative-packages -- test reaches into dist like the other suites
import { dependencyWatermarks } from "../dist/analyzer/project/cache/dependency-watermark.js";
import { WorkspaceCache } from "../dist/analyzer/project/cache/index.js";
import { resolveArchitectureOptions } from "../dist/index.js";
import { makeFixture } from "./support/fixtures.js";

const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

it("watermarks the analyzer version with the real package version", () => {
  const options = resolveArchitectureOptions({ projectRoot: "." });
  const marks = dependencyWatermarks(options, () => undefined);
  const versionMark = marks.find((m) => m.path === "__analyzer_version__");
  expect(versionMark, "analyzer-version watermark must exist").toBeDefined();
  expect(versionMark?.hash).toBe(PACKAGE_VERSION);
});

it("hashes a source file only once when replacing a stale disk cache", () => {
  const fixture = makeFixture({ "index.ts": "export const value = 1;\n" });
  const sourcePath = path.resolve(fixture.root, "index.ts");

  try {
    const options = resolveArchitectureOptions({ projectRoot: fixture.root });
    const cache = new WorkspaceCache();
    cache.get(options, () => null);

    writeFileSync(sourcePath, "export const value = 2;\n");
    cache.clear();

    const readFileSpy = vi.spyOn(fs, "readFileSync");
    try {
      cache.get(options, () => null);
      const sourceReads = readFileSpy.mock.calls.filter(
        ([file]) => typeof file === "string" && path.resolve(file) === sourcePath,
      );
      expect(sourceReads).toHaveLength(1);
    } finally {
      readFileSpy.mockRestore();
    }
  } finally {
    fixture.cleanup();
  }
});
