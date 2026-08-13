/**
 * @file Options-resolution contract: projectRoot is absolutized,
 * defaults populate omitted fields, and malformed input fails with the
 * per-issue explanation rather than deep in an analysis pass.
 */

import path from "node:path";
import { expect, it } from "vitest";
import { resolveArchitectureOptions } from "../src/index.js";
import { createProgram } from "../src/analyzer/project/source-files.js";
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

it("never caches options that fail semantic domain validation", () => {
  const invalid = {
    domains: [
      { name: "orders", roots: ["src/orders"], entrypoints: ["src/orders/index.ts"], reason: "one" },
      { name: "orders", roots: ["src/other"], entrypoints: ["src/other/index.ts"], reason: "two" },
    ],
  };
  expect(() => resolveArchitectureOptions(invalid)).toThrow("duplicate domain name");
  expect(() => resolveArchitectureOptions(invalid)).toThrow("duplicate domain name");
});

it("rejects traversing and conflicting domain paths", () => {
  expect(() => resolveArchitectureOptions({
    domains: [{
      name: "orders",
      roots: ["src/../orders"],
      entrypoints: ["orders/index.ts"],
      reason: "orders",
    }],
  })).toThrow("must stay inside the project root");

  expect(() => resolveArchitectureOptions({
    domains: [
      { name: "orders", roots: ["src/orders"], entrypoints: ["src/orders/index.ts"], reason: "orders" },
      { name: "billing", roots: ["src/billing"], entrypoints: ["src/billing/index.ts"], reason: "billing" },
    ],
    domainOwnership: [
      { path: "src/legacy", domain: "orders", reason: "first" },
      { path: "./src/legacy", domain: "billing", reason: "second" },
    ],
  })).toThrow("assigned more than once");
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
