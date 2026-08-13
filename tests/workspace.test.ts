/**
 * @file Checks workspace discovery and the cross-package check layered on it:
 * manifests whose package roots escape the workspace are rejected — for any
 * depth of climbing segments — a root with no manifest degrades to a single
 * named project, and a valid workspace yields one merged report with
 * deterministic package cycles. The merged cases shell out to the built CLI,
 * so dist must be current before they run.
 */

import { FastCheck as fc } from "effect";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverWorkspace, WORKSPACE_FILE_NAME } from "../src/analyzer/workspace/index.js";

const roots: string[] = [];
const BIN = path.resolve("dist/server/index.js");
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
  include: ["src/**/*.ts"],
});

/**
 * Fragments `discoverWorkspace` puts in `problem` for each refusal. They are
 * the contract a caller reads to tell the rejections apart.
 */
const PROBLEM_ESCAPES_WORKSPACE = "escapes the workspace";
const PROBLEM_SYMLINK_ESCAPE = "through a symlink";
const PROBLEM_INVALID_PACKAGE_JSON = "invalid package.json";
const PROBLEM_MISSING_NAME = "non-empty name";
const PROBLEM_DUPLICATE_ROOT = "duplicate package root";
const PROBLEM_DUPLICATE_NAME = "duplicate package name";

/** Manifest-relative package roots the multi-package fixtures use. */
const PACKAGE_A_ROOT = "packages/a";
const PACKAGE_B_ROOT = "packages/b";

/** What the merged workspace report must contain for the cycle fixture. */
const EXPECTED_PROJECT_NAMES = ["@fixture/a", "@fixture/b"];
const CYCLE_RULE_ID = "no-workspace-package-cycle";
const EXPECTED_CYCLE_PATH = "@fixture/a -> @fixture/b -> @fixture/a";
const SINGLE_PACKAGE_NAME = "@fixture/root";

/** `check` exit codes: findings are recoverable, a bad config is fatal. */
const EXIT_FINDINGS = 1;
const EXIT_INVALID_CONFIG = 2;

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });}
});

it("rejects workspace package roots that escape the explicit manifest", () => {
  const root = workspaceRoot();
  writeFileSync(
    path.join(root, WORKSPACE_FILE_NAME),
    JSON.stringify({ packages: ["../outside"] }),
  );
  const result = discoverWorkspace(root);
  // Analyzing a directory the manifest does not own would silently widen the
  // blast radius of a check, so discovery refuses instead of degrading.
  expect(result.ok).toBe(false);
  if (!result.ok) {expect(result.problem).toContain(PROBLEM_ESCAPES_WORKSPACE);}
});

it("rejects a package root at any climbing depth outside the workspace", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.constantFrom("outside", "sibling", "vendor"),
      (depth, leaf) => {
        const root = workspaceRoot();
        writeFileSync(
          path.join(root, WORKSPACE_FILE_NAME),
          JSON.stringify({ packages: [`${"../".repeat(depth)}${leaf}`] }),
        );
        const result = discoverWorkspace(root);
        // Containment, not one hand-picked path, is the invariant: no number
        // of `..` segments and no target name may leave the workspace root.
        expect(result.ok).toBe(false);
        if (!result.ok) {expect(result.problem).toContain(PROBLEM_ESCAPES_WORKSPACE);}
      },
    ),
    { numRuns: 24 },
  );
});

it("rejects workspace package roots that escape through a symlink", () => {
  const root = workspaceRoot();
  const outside = workspaceRoot();
  writePackage(outside, ".", "@fixture/outside");
  mkdirSync(path.join(root, "packages"), { recursive: true });
  symlinkSync(outside, path.join(root, "packages/outside"), "dir");
  writeFileSync(
    path.join(root, WORKSPACE_FILE_NAME),
    JSON.stringify({ packages: ["packages/outside"] }),
  );
  const result = discoverWorkspace(root);
  // The lexical path stays inside the root, so only realpath resolution can
  // catch this escape; the distinct message proves that check ran.
  expect(result.ok).toBe(false);
  if (!result.ok) {expect(result.problem).toContain(PROBLEM_SYMLINK_ESCAPE);}
});

it.each([
  ["invalid JSON", "{", "invalid JSON"],
  ["wrong shape", JSON.stringify({ packages: "packages/a" }), "packages"],
  ["empty package list", JSON.stringify({ packages: [] }), "at least one"],
  ["absolute root", JSON.stringify({ packages: ["/srv/absolute-package"] }), "must be relative"],
  ["missing directory", JSON.stringify({ packages: ["packages/missing"] }), "not a directory"],
])("rejects %s", (label, manifest, message) => {
  const root = workspaceRoot();
  writeFileSync(path.join(root, WORKSPACE_FILE_NAME), manifest);
  const result = discoverWorkspace(root);
  // Each manifest here is unusable in a different way; discovery must refuse
  // all of them rather than analyze a partially understood workspace.
  expect(result.ok, `expected the ${label} manifest to be refused`).toBe(false);
  if (!result.ok) {expect(result.problem).toContain(message);}
});

it("rejects invalid, unnamed, duplicate-root, and duplicate-name packages", () => {
  const invalidJsonRoot = workspaceRoot();
  mkdirSync(path.join(invalidJsonRoot, PACKAGE_A_ROOT), { recursive: true });
  writeFileSync(path.join(invalidJsonRoot, PACKAGE_A_ROOT, "package.json"), "{");
  writeManifest(invalidJsonRoot, [PACKAGE_A_ROOT]);
  const invalidJson = discoverWorkspace(invalidJsonRoot);
  // A package.json that cannot be parsed leaves the package's name and deps
  // unknown, so the workspace cannot be expanded at all.
  expect(invalidJson.ok).toBe(false);
  if (!invalidJson.ok) {expect(invalidJson.problem).toContain(PROBLEM_INVALID_PACKAGE_JSON);}

  const unnamedRoot = workspaceRoot();
  mkdirSync(path.join(unnamedRoot, PACKAGE_A_ROOT), { recursive: true });
  writeFileSync(path.join(unnamedRoot, PACKAGE_A_ROOT, "package.json"), "{}");
  writeManifest(unnamedRoot, [PACKAGE_A_ROOT]);
  const unnamed = discoverWorkspace(unnamedRoot);
  // Cross-package edges are keyed by name, so a manifest package without one
  // cannot participate and is refused rather than defaulted.
  expect(unnamed.ok).toBe(false);
  if (!unnamed.ok) {expect(unnamed.problem).toContain(PROBLEM_MISSING_NAME);}

  const blankRoot = workspaceRoot();
  writePackage(blankRoot, PACKAGE_A_ROOT, "   ");
  writeManifest(blankRoot, [PACKAGE_A_ROOT]);
  const blank = discoverWorkspace(blankRoot);
  // Whitespace is not a name: the same refusal must cover a blank string as
  // covers a missing field.
  expect(blank.ok).toBe(false);
  if (!blank.ok) {expect(blank.problem).toContain(PROBLEM_MISSING_NAME);}

  const duplicateRoot = workspaceRoot();
  writePackage(duplicateRoot, PACKAGE_A_ROOT, "@fixture/a");
  writeManifest(duplicateRoot, [PACKAGE_A_ROOT, PACKAGE_A_ROOT]);
  const duplicate = discoverWorkspace(duplicateRoot);
  // Listing a root twice would double-count its files in the merged report,
  // so the duplicate is a manifest error rather than a de-duplication.
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) {expect(duplicate.problem).toContain(PROBLEM_DUPLICATE_ROOT);}

  const duplicateNameRoot = workspaceRoot();
  writePackage(duplicateNameRoot, PACKAGE_A_ROOT, "@fixture/same");
  writePackage(duplicateNameRoot, PACKAGE_B_ROOT, "@fixture/same");
  writeManifest(duplicateNameRoot, [PACKAGE_A_ROOT, PACKAGE_B_ROOT]);
  const duplicateName = discoverWorkspace(duplicateNameRoot);
  // Two distinct roots claiming one name make dependency edges ambiguous,
  // which is a different failure from a duplicated root.
  expect(duplicateName.ok).toBe(false);
  if (!duplicateName.ok) {expect(duplicateName.problem).toContain(PROBLEM_DUPLICATE_NAME);}
});

it("falls back to a named single project when no workspace manifest exists", () => {
  const root = workspaceRoot();
  writePackage(root, ".", SINGLE_PACKAGE_NAME);
  const result = discoverWorkspace(root);
  // A manifest-less root is still a workspace; `manifestPath: null` is what
  // lets cross-package checks tell the fallback from an explicit list.
  expect(result.ok).toBe(true);
  if (!result.ok) {return;}
  expect(result.workspace.manifestPath).toBeNull();
  // The one project keeps its package.json name rather than the temp
  // directory name, so reports stay stable across runs.
  expect(result.workspace.projects.map(({ name }) => name)).toEqual([SINGLE_PACKAGE_NAME]);
});

it("merges project reports, snapshots, and deterministic package cycles", () => {
  const root = workspaceRoot();
  writePackage(root, PACKAGE_A_ROOT, "@fixture/a", "@fixture/b");
  writePackage(root, PACKAGE_B_ROOT, "@fixture/b", "@fixture/a");
  writeManifest(root, [PACKAGE_B_ROOT, PACKAGE_A_ROOT]);

  const result = spawnSync(process.execPath, [BIN, "check", root, "--json"], {
    encoding: "utf8",
  });
  // Findings are a recoverable outcome, so the CLI still emits its report and
  // exits 1 — the code CI keys "there are architecture findings" off.
  expect(result.status).toBe(EXIT_FINDINGS);
  const report =
    // `check --json` guarantees exactly one report object on stdout, so the
    // parsed shape is known even though JSON.parse itself is untyped.
    JSON.parse(result.stdout) as {
      projects: ReadonlyArray<{ name: string }>;
      diagnostics: ReadonlyArray<{ ruleId: string; message: string }>;
      snapshots: ReadonlyArray<{ projectRoot: string; sourceFiles: readonly string[] }>;
    };
  // The manifest lists b before a, so name order here proves the merge sorts
  // rather than echoing manifest order.
  expect(report.projects.map(({ name }) => name)).toEqual(EXPECTED_PROJECT_NAMES);
  const cycleMessages = report.diagnostics
    .filter(({ ruleId }) => ruleId === CYCLE_RULE_ID)
    .map(({ message }) => message);
  // The cycle is rendered from its lowest-sorting member, so the same cycle
  // prints identically no matter which package the walk entered from.
  expect(cycleMessages.some((message) => message.includes(EXPECTED_CYCLE_PATH))).toBe(true);
  expect(report.snapshots).toHaveLength(EXPECTED_PROJECT_NAMES.length);
  expect(report.snapshots.every((snapshot) => snapshot.sourceFiles.length === 1)).toBe(true);
});

it("blocks the whole workspace when one package config is invalid", () => {
  const root = workspaceRoot();
  writePackage(root, PACKAGE_A_ROOT, "@fixture/a");
  writePackage(root, PACKAGE_B_ROOT, "@fixture/b");
  writeManifest(root, [PACKAGE_A_ROOT, PACKAGE_B_ROOT]);
  writeFileSync(path.join(root, PACKAGE_B_ROOT, "safer-architecture.config.json"), "{");

  const result = spawnSync(process.execPath, [BIN, "check", root], { encoding: "utf8" });
  // An unreadable config is fatal, not a finding: nothing is written to
  // stdout, so a broken package can never be mistaken for a clean one.
  expect(result.status).toBe(EXIT_INVALID_CONFIG);
  expect(result.stderr).toContain(PACKAGE_B_ROOT);
  expect(result.stdout).toBe("");
});

function workspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "safer-arch-workspace-"));
  roots.push(root);
  return root;
}

function writeManifest(root: string, packages: readonly string[]): void {
  writeFileSync(path.join(root, WORKSPACE_FILE_NAME), JSON.stringify({ packages }));
}

function writePackage(
  root: string,
  relative: string,
  name: string,
  dependency?: string,
): void {
  const packageRoot = path.join(root, relative);
  mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  writeFileSync(path.join(packageRoot, "tsconfig.json"), TSCONFIG);
  writeFileSync(path.join(packageRoot, "src/index.ts"), "export const value = 1;\n");
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name,
    dependencies: dependency === undefined ? {} : { [dependency]: "workspace:*" },
  }));
}
