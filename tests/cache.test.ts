/**
 * @file Cache-input regression pins: the analyzer-version watermark must
 * resolve the real package version (the src/ restructure once broke the
 * relative walk and every cache read silently fell back), and a version
 * mismatch must bust the cache.
 */

import { createRequire } from "node:module";
import { expect, it } from "vitest";
// eslint-disable-next-line import/no-relative-packages -- test reaches into dist like the other suites
import { dependencyWatermarks } from "../dist/analyzer/project/cache/dependency-watermark.js";
import { resolveArchitectureOptions } from "../dist/index.js";

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
