/**
 * @file Soundness regressions for the public-type export pre-filter. With
 * `types: []`, ambient declarations do not disable the fast path, so every
 * external type entry path must seed the full semantic type walk itself.
 */

import { FastCheck as fc } from "effect";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProjectGraph } from "../src/analyzer/imports/project-graph/index.js";
import { emptyPackageJson } from "../src/analyzer/package-api/index.js";
import {
  createProgram,
  projectSourceFiles,
} from "../src/analyzer/project/source-files.js";
import { buildExternalTypeReach } from "../src/analyzer/type-surface/external-reach.js";
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "../src/index.js";
import { type Fixture, makeFixture } from "./support/fixtures.js";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const REPO_NODE_MODULES = path.resolve("node_modules");
const VENDOR_NAME = "fixture-vendor";

/** The rule every soundness case in this file must keep reporting. */
const VENDOR_LEAK_RULE_ID = "no-public-vendor-type-leak";

/** Token in an entry form that stands for the exported type's name. */
const ALIAS_PLACEHOLDER = "ALIAS";

/**
 * Public-export shapes that each reach the same vendor declaration through a
 * different entry path. Every one of them must produce the leak finding.
 */
const VENDOR_ENTRY_FORMS: readonly string[] = [
  `export type ${ALIAS_PLACEHOLDER} = import("${VENDOR_NAME}").VendorType;\n`,
  `import vendor = require("${VENDOR_NAME}");\n` +
    `export type ${ALIAS_PLACEHOLDER} = vendor.VendorType;\n`,
  `import type { VendorType } from "${VENDOR_NAME}";\n` +
    `export type ${ALIAS_PLACEHOLDER} = VendorType;\n`,
  `import type { VendorType } from "${VENDOR_NAME}";\n` +
    `export interface ${ALIAS_PLACEHOLDER} { readonly vendor: VendorType; }\n`,
];

const TYPES_EMPTY_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    types: [],
  },
  include: ["**/*.ts"],
});
const VENDOR_PACKAGE_JSON = JSON.stringify({
  name: VENDOR_NAME,
  version: "1.0.0",
  types: "index.d.ts",
});
const PLAIN_VENDOR_DECLARATIONS = [
  "export interface VendorType {",
  "  readonly vendorValue: string;",
  "}",
  "",
].join("\n");
const GLOBAL_VENDOR_DECLARATIONS = [
  PLAIN_VENDOR_DECLARATIONS,
  "declare global {",
  "  interface FixtureVendorGlobal {",
  "    readonly vendor: VendorType;",
  "  }",
  "}",
  "",
].join("\n");

function makeSoundnessFixture(
  indexSource: string,
  vendorDeclarations = PLAIN_VENDOR_DECLARATIONS,
): Fixture {
  return makeFixture({
    "tsconfig.json": TYPES_EMPTY_TSCONFIG,
    "package.json": JSON.stringify({
      name: "fixture-package",
      exports: { ".": "./index.ts" },
    }),
    "index.ts": indexSource,
    [`node_modules/${VENDOR_NAME}/package.json`]: VENDOR_PACKAGE_JSON,
    [`node_modules/${VENDOR_NAME}/index.d.ts`]: vendorDeclarations,
  });
}

function vendorLeakDiagnostics(root: string) {
  return analyzeResolvedArchitecture(
    resolveArchitectureOptions({ projectRoot: root }),
  ).diagnostics.filter((diagnostic) =>
    diagnostic.ruleId === VENDOR_LEAK_RULE_ID &&
    diagnostic.message.includes(VENDOR_NAME)
  );
}

it("reports a vendor leak for every public entry path and alias", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...VENDOR_ENTRY_FORMS),
      fc.constantFrom("PublicType", "ExposedShape", "Api"),
      (form, alias) => {
        const created = makeSoundnessFixture(form.replaceAll(ALIAS_PLACEHOLDER, alias));
        try {
          // Soundness is a property of the reachability walk, not of one
          // syntax: any public export that reaches the vendor declaration
          // must be reported, whatever route or name it uses.
          expect(vendorLeakDiagnostics(created.root)).not.toHaveLength(0);
        } finally {
          created.cleanup();
        }
      },
    ),
    { numRuns: VENDOR_ENTRY_FORMS.length * 3 },
  );
});

it("walks an export reached through an import() type node", () => {
  fixture = makeSoundnessFixture(
    `export type PublicType = import("${VENDOR_NAME}").VendorType;\n`,
  );

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("walks an export reached through import = require()", () => {
  fixture = makeSoundnessFixture(
    `import vendor = require("${VENDOR_NAME}");\n` +
      "export type PublicType = vendor.VendorType;\n",
  );

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("walks an export whose JSX type comes from jsxImportSource", () => {
  fixture = makeFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        jsx: "react-jsx",
        jsxImportSource: VENDOR_NAME,
      },
      include: ["**/*.tsx"],
    }),
    "package.json": JSON.stringify({
      name: "fixture-package",
      type: "module",
      exports: { ".": "./index.tsx" },
    }),
    "index.tsx": "export function PublicView() { return <div />; }\n",
    [`node_modules/${VENDOR_NAME}/package.json`]: JSON.stringify({
      name: VENDOR_NAME,
      version: "1.0.0",
      type: "module",
      exports: {
        "./jsx-runtime": {
          types: "./jsx-runtime.d.ts",
          default: "./jsx-runtime.js",
        },
      },
    }),
    [`node_modules/${VENDOR_NAME}/jsx-runtime.d.ts`]: [
      "export namespace JSX {",
      "  interface Element { readonly vendorElement: true; }",
      "  interface IntrinsicElements { div: {}; }",
      "}",
      "export function jsx(type: string, props: unknown): JSX.Element;",
      "export { jsx as jsxs, jsx as jsxDEV };",
      "",
    ].join("\n"),
  });

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("fails open when TypeScript resolves a different local module than the graph", () => {
  fixture = makeFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        moduleSuffixes: [".native", ""],
      },
      include: ["**/*.ts"],
    }),
    "package.json": JSON.stringify({
      name: "fixture-package",
      type: "module",
      exports: { ".": "./index.ts" },
    }),
    "index.ts":
      'import type { InternalType } from "./internal.js";\n' +
      "export type PublicType = InternalType;\n",
    "internal.ts":
      "export interface InternalType { readonly packageOwned: string; }\n",
    "internal.native.ts":
      `export type InternalType = import("${VENDOR_NAME}").VendorType;\n`,
    [`node_modules/${VENDOR_NAME}/package.json`]: VENDOR_PACKAGE_JSON,
    [`node_modules/${VENDOR_NAME}/index.d.ts`]: PLAIN_VENDOR_DECLARATIONS,
  });

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("walks an export reached through a triple-slash types reference", () => {
  fixture = makeSoundnessFixture(
    `/// <reference types="${VENDOR_NAME}" />\n` +
      "export type PublicType = FixtureVendorGlobal;\n",
    GLOBAL_VENDOR_DECLARATIONS,
  );

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("treats a string-literal module declaration as requiring the full walk", () => {
  fixture = makeSoundnessFixture(
    `declare module "${VENDOR_NAME}" {\n` +
      "  interface VendorType { readonly augmented: true; }\n" +
      "}\n" +
      "export interface PublicType { readonly local: string; }\n",
  );
  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const program = createProgram(options);
  expect(program).not.toBeNull();
  if (program === null) {return;}

  const sourceFiles = projectSourceFiles(program, fixture.root);
  const publicFile = sourceFiles.find((sourceFile) =>
    path.basename(sourceFile.fileName) === "index.ts"
  );
  expect(publicFile).toBeDefined();
  if (publicFile === undefined) {return;}

  const graph = buildProjectGraph(
    sourceFiles,
    emptyPackageJson(),
    options,
    publicFile.fileName,
  );
  const mayReachExternal = buildExternalTypeReach(
    program,
    graph,
    (specifier) => specifier.startsWith(".") ? null : specifier,
  );

  expect(mayReachExternal(publicFile)).toBe(true);
});

it("keeps a checker-resolved internal # edge on the local fast path", () => {
  fixture = makeFixture({
    "tsconfig.json": TYPES_EMPTY_TSCONFIG,
    "package.json": JSON.stringify({
      name: "fixture-package",
      imports: { "#internal": "./internal.ts" },
      exports: { ".": "./index.ts" },
    }),
    "index.ts":
      'import type { InternalType } from "#internal";\n' +
      "export type PublicType = InternalType;\n",
    "internal.ts":
      "export interface InternalType { readonly packageOwned: string; }\n",
  });
  const options = resolveArchitectureOptions({ projectRoot: fixture.root });
  const program = createProgram(options);
  expect(program).not.toBeNull();
  if (program === null) {return;}

  const sourceFiles = projectSourceFiles(program, fixture.root);
  const publicFile = sourceFiles.find((sourceFile) =>
    path.basename(sourceFile.fileName) === "index.ts"
  );
  expect(publicFile).toBeDefined();
  if (publicFile === undefined) {return;}

  const graph = buildProjectGraph(
    sourceFiles,
    emptyPackageJson(),
    options,
    publicFile.fileName,
  );
  const mayReachExternal = buildExternalTypeReach(
    program,
    graph,
    (specifier) =>
      specifier.startsWith(".") || specifier.startsWith("#")
        ? null
        : specifier,
  );

  expect(mayReachExternal(publicFile)).toBe(false);
});

it("walks an export reached through an external module augmentation", () => {
  fixture = makeSoundnessFixture(
    `declare module "${VENDOR_NAME}" {\n` +
      "  interface VendorType { readonly augmented: true; }\n" +
      "}\n" +
      `export type PublicType = import("${VENDOR_NAME}").VendorType;\n`,
  );

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("walks declarations changed by an augmentation in another file", () => {
  fixture = makeFixture({
    "tsconfig.json": TYPES_EMPTY_TSCONFIG,
    "package.json": JSON.stringify({
      name: "fixture-package",
      exports: { ".": "./index.ts" },
    }),
    "index.ts":
      "export interface PublicType { readonly packageOwned: string; }\n",
    "augment.ts":
      `import type { VendorType } from "${VENDOR_NAME}";\n` +
      'declare module "./index.js" {\n' +
      "  interface PublicType { readonly vendor: VendorType; }\n" +
      "}\n",
    [`node_modules/${VENDOR_NAME}/package.json`]: VENDOR_PACKAGE_JSON,
    [`node_modules/${VENDOR_NAME}/index.d.ts`]: PLAIN_VENDOR_DECLARATIONS,
  });

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("walks CommonJS require types reached through a JavaScript re-export", () => {
  fixture = makeFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        allowJs: true,
        checkJs: true,
      },
      include: ["**/*.ts", "**/*.js"],
    }),
    "package.json": JSON.stringify({
      name: "fixture-package",
      exports: { ".": "./index.ts" },
    }),
    "index.ts": 'export * from "./internal.js";\n',
    "internal.js":
      `const vendor = require("${VENDOR_NAME}");\n` +
      "exports.publicValue = vendor.vendorValue;\n",
    [`node_modules/${VENDOR_NAME}/package.json`]: JSON.stringify({
      name: VENDOR_NAME,
      version: "1.0.0",
      main: "./index.js",
      types: "./index.d.ts",
    }),
    [`node_modules/${VENDOR_NAME}/index.js`]:
      "exports.vendorValue = { vendorValue: 'vendor' };\n",
    [`node_modules/${VENDOR_NAME}/index.d.ts`]: [
      "export interface VendorType { readonly vendorValue: string; }",
      "export const vendorValue: VendorType;",
      "",
    ].join("\n"),
  });

  expect(vendorLeakDiagnostics(fixture.root)).not.toHaveLength(0);
});

it("preserves the import() finding when ambient types already force a full walk", () => {
  fixture = makeFixture({
    "package.json": JSON.stringify({
      name: "fixture-package",
      exports: { ".": "./index.ts" },
    }),
    "index.ts":
      'export type PublicType = import("effect").Effect.Effect<number>;\n',
  });
  symlinkSync(REPO_NODE_MODULES, path.join(fixture.root, "node_modules"), "dir");

  const ruleIds = analyzeResolvedArchitecture(
    resolveArchitectureOptions({ projectRoot: fixture.root }),
  ).diagnostics.map((diagnostic) => diagnostic.ruleId);
  // Ambient `effect` types already force the full walk, so this pins that the
  // import() finding survives that path instead of being deduplicated away.
  expect(ruleIds).toContain(VENDOR_LEAK_RULE_ID);
});
