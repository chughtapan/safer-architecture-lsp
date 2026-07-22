/**
 * @file Options-resolution contract: projectRoot is absolutized,
 * defaults populate omitted fields, and malformed input fails with the
 * per-issue explanation rather than deep in an analysis pass.
 */

import path from "node:path";
import { expect, it } from "vitest";
import { resolveArchitectureOptions } from "../dist/index.js";

it("resolves a bare projectRoot to absolute with defaults applied", () => {
  const resolved = resolveArchitectureOptions({ projectRoot: "." });
  expect(path.isAbsolute(resolved.projectRoot)).toBe(true);
});

it("rejects malformed options with a per-issue message", () => {
  expect(() =>
    resolveArchitectureOptions({ projectRoot: 42 } as never),
  ).toThrowError(/architecture options/i);
});

it("rejects an allowance entry missing its written reason", () => {
  expect(() =>
    resolveArchitectureOptions({
      projectRoot: ".",
      allowedPublicSubpaths: [{ subpath: "./cli" }],
    } as never),
  ).toThrowError(/architecture options/i);
});
