/**
 * @file Node subpath imports (`package.json` `imports`, `#`-specifiers)
 * resolve inside the package: a public re-export from a `#` subpath that
 * maps to an in-package path must not trip `no-public-vendor-type-leak`
 * or `require-boundary-owned-types`. A `#` key that maps to a bare
 * package is still a vendor edge and must fire.
 */

import * as fc from "effect/FastCheck";
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

/** The two rules a `#` specifier can trip once it is treated as a vendor edge. */
const VENDOR_TYPE_LEAK_RULE: ArchitectureDiagnosticRuleId = "no-public-vendor-type-leak";
const BOUNDARY_OWNED_TYPES_RULE: ArchitectureDiagnosticRuleId = "require-boundary-owned-types";

const SUBPATH_RULES = [VENDOR_TYPE_LEAK_RULE, BOUNDARY_OWNED_TYPES_RULE] as const;

/** Identifier-safe names for generated `#` keys and their in-package targets. */
const NAME_ARBITRARY = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/);

function ruleIdsFor(root: string): readonly string[] {
  const options = resolveArchitectureOptions({ projectRoot: root });
  return analyzeResolvedArchitecture(options).diagnostics.map((d) => d.ruleId);
}

it("treats an internal `#` re-export as package-owned, not a vendor leak", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "my-pkg",
      imports: { "#socket": "./socket/index.ts" },
      exports: { ".": "./index.ts" },
    }),
    "index.ts": 'export { MyClient } from "#socket";\n',
    "socket/index.ts": "export class MyClient {\n  connect(): void {}\n}\n",
  });

  const ruleIds = ruleIdsFor(fixture.root);
  for (const rule of SUBPATH_RULES) {expect(ruleIds).not.toContain(rule);}
});

it("treats a `#` import referenced in an exported declaration as internal", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "my-pkg",
      imports: { "#socket": "./socket/index.ts" },
      exports: { ".": "./index.ts" },
    }),
    "index.ts":
      'import { MyClient } from "#socket";\nexport function open(): MyClient {\n  return new MyClient();\n}\n',
    "socket/index.ts": "export class MyClient {\n  connect(): void {}\n}\n",
  });

  const ruleIds = ruleIdsFor(fixture.root);
  for (const rule of SUBPATH_RULES) {expect(ruleIds).not.toContain(rule);}
});

it("still flags a `#` key that maps to a bare vendor package", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "my-pkg",
      imports: { "#vendor": "some-vendor-pkg" },
      exports: { ".": "./index.ts" },
    }),
    "index.ts": 'export { Thing } from "#vendor";\n',
  });

  const diagnostics = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ projectRoot: fixture.root }),
  ).diagnostics;
  const forVendor = diagnostics.filter((d) => d.message.includes("some-vendor-pkg"));
  // The `#vendor` key resolves outside the package, so the re-exported type is
  // owned by a third party: it leaks a vendor type through the public surface...
  expect(forVendor.map((d) => d.ruleId)).toContain(VENDOR_TYPE_LEAK_RULE);
  // ...and the boundary re-exports a type it does not own.
  expect(forVendor.map((d) => d.ruleId)).toContain(BOUNDARY_OWNED_TYPES_RULE);
});

it("still flags a wildcard `#` key that maps to a bare vendor package", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "my-pkg",
      imports: { "#gen/*": "some-vendor/*" },
      exports: { ".": "./index.ts" },
    }),
    "index.ts": 'export { Thing } from "#gen/x";\n',
  });

  const diagnostics = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ projectRoot: fixture.root }),
  ).diagnostics;
  const forVendor = diagnostics.filter((d) => d.message.includes("some-vendor"));
  // Expanding `#gen/*` lands on a bare package just as the non-wildcard key
  // does, so the wildcard form must reach the same two verdicts.
  expect(forVendor.map((d) => d.ruleId)).toContain(VENDOR_TYPE_LEAK_RULE);
  expect(forVendor.map((d) => d.ruleId)).toContain(BOUNDARY_OWNED_TYPES_RULE);
});

it("treats a wildcard `#` re-export as package-owned when it maps internally", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "my-pkg",
      imports: { "#impl/*": "./impl/*" },
      exports: { ".": "./index.ts" },
    }),
    "index.ts": 'export { Thing } from "#impl/x";\n',
    "impl/x.ts": "export class Thing {}\n",
  });

  const ruleIds = ruleIdsFor(fixture.root);
  for (const rule of SUBPATH_RULES) {expect(ruleIds).not.toContain(rule);}
});

/**
 * The examples above pin two hand-picked key names (`#socket`, `#impl/*`). The
 * invariant is name-independent: whenever a `#` key resolves to a path inside
 * the package, the re-export is package-owned, so neither subpath rule may fire
 * — for any key name, any target folder, and either mapping form.
 */
it("treats every internally-mapped `#` key as package-owned, plain or wildcard", () => {
  fc.assert(
    fc.property(NAME_ARBITRARY, NAME_ARBITRARY, fc.boolean(), (key, target, wildcard) => {
      const project = makeFixture(internalSubpathProject(key, target, wildcard));
      try {
        const ruleIds = ruleIdsFor(project.root);
        for (const rule of SUBPATH_RULES) {expect(ruleIds).not.toContain(rule);}
      } finally {
        project.cleanup();
      }
    }),
    { numRuns: 6 },
  );
});

/**
 * Build a package whose single public export is re-exported through a `#` key
 * that maps inside the package.
 * @param key Subpath key name, written as `#key` or `#key/*`.
 * @param target Folder the key maps into.
 * @param wildcard Whether to use the `#key/*` pattern form.
 * @returns Fixture files for `makeFixture`.
 */
function internalSubpathProject(
  key: string,
  target: string,
  wildcard: boolean,
): Readonly<Record<string, string>> {
  const imports = wildcard ? { [`#${key}/*`]: `./${target}/*` } : { [`#${key}`]: `./${target}/index.ts` };
  const specifier = wildcard ? `#${key}/x` : `#${key}`;
  const implementationFile = wildcard ? `${target}/x.ts` : `${target}/index.ts`;
  return {
    "package.json": JSON.stringify({ name: "my-pkg", imports, exports: { ".": "./index.ts" } }),
    "index.ts": `export { Thing } from "${specifier}";\n`,
    [implementationFile]: "export class Thing {}\n",
  };
}
