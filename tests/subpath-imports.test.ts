/**
 * @file Node subpath imports (`package.json` `imports`, `#`-specifiers)
 * resolve inside the package: a public re-export from a `#` subpath that
 * maps to an in-package path must not trip `no-public-vendor-type-leak`
 * or `require-boundary-owned-types`. A `#` key that maps to a bare
 * package is still a vendor edge and must fire.
 */

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

const SUBPATH_RULES = ["no-public-vendor-type-leak", "require-boundary-owned-types"] as const;

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
  for (const rule of SUBPATH_RULES) expect(ruleIds).not.toContain(rule);
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
  for (const rule of SUBPATH_RULES) expect(ruleIds).not.toContain(rule);
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
  expect(forVendor.map((d) => d.ruleId)).toContain("no-public-vendor-type-leak");
  expect(forVendor.map((d) => d.ruleId)).toContain("require-boundary-owned-types");
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
  expect(forVendor.map((d) => d.ruleId)).toContain("no-public-vendor-type-leak");
  expect(forVendor.map((d) => d.ruleId)).toContain("require-boundary-owned-types");
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
  for (const rule of SUBPATH_RULES) expect(ruleIds).not.toContain(rule);
});
