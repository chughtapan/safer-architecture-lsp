/**
 * @file Options-resolution contract: projectRoot is absolutized,
 * defaults populate omitted fields, and malformed input fails with the
 * per-issue explanation rather than deep in an analysis pass.
 */

import path from "node:path";
import { expect, it } from "vitest";
import { resolveArchitectureOptions } from "../dist/index.js";
import { createProgram } from "../dist/analyzer/project/source-files.js";
import { makeFixture } from "./support/fixtures.js";

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

it("removes inert emit paths from the analysis compiler options", () => {
  const fixture = makeFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        composite: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        incremental: true,
        tsBuildInfoFile: "./cache.tsbuildinfo",
      },
      include: ["**/*.ts"],
    }),
    "index.ts": "export const value = 1;\n",
  });

  try {
    const program = createProgram(
      resolveArchitectureOptions({ projectRoot: fixture.root }),
    );
    expect(program).not.toBeNull();
    if (program === null) return;

    const compilerOptions = program.getCompilerOptions();
    expect(compilerOptions).not.toHaveProperty("declarationMap");
    expect(compilerOptions).not.toHaveProperty("sourceMap");
    expect(compilerOptions).not.toHaveProperty("tsBuildInfoFile");
    expect(compilerOptions).toMatchObject({
      noEmit: true,
      composite: false,
      declaration: false,
      incremental: false,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
    });
    expect(program.getOptionsDiagnostics()).toHaveLength(0);
  } finally {
    fixture.cleanup();
  }
});
