/**
 * @file Options-resolution contract: projectRoot is absolutized,
 * defaults populate omitted fields, and malformed input fails with the
 * per-issue explanation rather than deep in an analysis pass.
 */

import path from "node:path";
import { expect, it } from "vitest";
import { createProgram } from "../src/analyzer/project/source-files.js";
import { resolveArchitectureOptions } from "../src/index.js";
import { makeFixture } from "./support/fixtures.js";

interface RejectedOptionCase {
  /** The raw input handed to `resolveArchitectureOptions`. */
  readonly input: unknown;
  /** The explanation the caller must get back for that input. */
  readonly message: RegExp;
}

/**
 * One entry per rejection branch the examples below pin individually: schema
 * shape, missing written reason, duplicate domain name, escaping root, and a
 * doubly-assigned ownership path.
 */
const REJECTED_OPTION_CASES: readonly RejectedOptionCase[] = [
  { input: { projectRoot: 42 }, message: /architecture options/i },
  {
    input: { projectRoot: ".", allowedPublicSubpaths: [{ subpath: "./cli" }] },
    message: /architecture options/i,
  },
  {
    input: {
      domains: [
        { name: "orders", roots: ["src/orders"], entrypoints: ["src/orders/index.ts"], reason: "one" },
        { name: "orders", roots: ["src/other"], entrypoints: ["src/other/index.ts"], reason: "two" },
      ],
    },
    message: /duplicate domain name/,
  },
  {
    input: {
      domains: [{
        name: "orders",
        roots: ["src/../orders"],
        entrypoints: ["orders/index.ts"],
        reason: "orders",
      }],
    },
    message: /must stay inside the project root/,
  },
  {
    input: {
      domains: [
        { name: "orders", roots: ["src/orders"], entrypoints: ["src/orders/index.ts"], reason: "orders" },
        { name: "billing", roots: ["src/billing"], entrypoints: ["src/billing/index.ts"], reason: "billing" },
      ],
      domainOwnership: [
        { path: "src/legacy", domain: "orders", reason: "first" },
        { path: "./src/legacy", domain: "billing", reason: "second" },
      ],
    },
    message: /assigned more than once/,
  },
];

it("resolves a bare projectRoot to absolute with defaults applied", () => {
  const resolved = resolveArchitectureOptions({ projectRoot: "." });
  expect(path.isAbsolute(resolved.projectRoot)).toBe(true);
});

it("rejects malformed options with a per-issue message", () => {
  expect(() =>
    resolveArchitectureOptions({ projectRoot: 42 }),
  ).toThrowError(/architecture options/i);
});

it("rejects an allowance entry missing its written reason", () => {
  expect(() =>
    resolveArchitectureOptions({
      projectRoot: ".",
      allowedPublicSubpaths: [{ subpath: "./cli" }],
    }),
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
    if (program === null) {return;}

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

it("rejects every malformed option shape, and rejects the same object again", () => {
  for (const rejected of REJECTED_OPTION_CASES) {
    // Each shape has to fail with the explanation that names its own defect,
    // which is what lets a caller fix the config without bisecting it.
    expect(() => resolveArchitectureOptions(rejected.input)).toThrow(rejected.message);
    // The decode cache is keyed by object identity, so semantic validation has
    // to run before the cache is written or the second resolve would succeed.
    expect(() => resolveArchitectureOptions(rejected.input)).toThrow(rejected.message);
  }
});
