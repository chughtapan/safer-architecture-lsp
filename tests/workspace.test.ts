import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverWorkspace } from "../src/analyzer/workspace/index.js";

const roots: string[] = [];
const BIN = path.resolve("dist/server/index.js");
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
  include: ["src/**/*.ts"],
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("rejects workspace package roots that escape the explicit manifest", () => {
  const root = workspaceRoot();
  writeFileSync(
    path.join(root, "safer-architecture.workspace.json"),
    JSON.stringify({ packages: ["../outside"] }),
  );
  const result = discoverWorkspace(root);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problem).toContain("escapes the workspace");
});

it.each([
  ["invalid JSON", "{", "invalid JSON"],
  ["wrong shape", JSON.stringify({ packages: "packages/a" }), "packages"],
  ["empty package list", JSON.stringify({ packages: [] }), "at least one"],
  ["absolute root", JSON.stringify({ packages: ["/tmp/absolute"] }), "must be relative"],
  ["missing directory", JSON.stringify({ packages: ["packages/missing"] }), "not a directory"],
])("rejects %s", (_label, manifest, message) => {
  const root = workspaceRoot();
  writeFileSync(path.join(root, "safer-architecture.workspace.json"), manifest);
  const result = discoverWorkspace(root);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problem).toContain(message);
});

it("rejects invalid, unnamed, duplicate-root, and duplicate-name packages", () => {
  const invalidJsonRoot = workspaceRoot();
  mkdirSync(path.join(invalidJsonRoot, "packages/a"), { recursive: true });
  writeFileSync(path.join(invalidJsonRoot, "packages/a/package.json"), "{");
  writeFileSync(path.join(invalidJsonRoot, "safer-architecture.workspace.json"), JSON.stringify({ packages: ["packages/a"] }));
  const invalidJson = discoverWorkspace(invalidJsonRoot);
  expect(invalidJson.ok).toBe(false);
  if (!invalidJson.ok) expect(invalidJson.problem).toContain("invalid package.json");

  const unnamedRoot = workspaceRoot();
  mkdirSync(path.join(unnamedRoot, "packages/a"), { recursive: true });
  writeFileSync(path.join(unnamedRoot, "packages/a/package.json"), "{}");
  writeFileSync(path.join(unnamedRoot, "safer-architecture.workspace.json"), JSON.stringify({ packages: ["packages/a"] }));
  const unnamed = discoverWorkspace(unnamedRoot);
  expect(unnamed.ok).toBe(false);
  if (!unnamed.ok) expect(unnamed.problem).toContain("non-empty name");

  const duplicateRoot = workspaceRoot();
  writePackage(duplicateRoot, "packages/a", "@fixture/a");
  writeFileSync(path.join(duplicateRoot, "safer-architecture.workspace.json"), JSON.stringify({ packages: ["packages/a", "packages/a"] }));
  const duplicate = discoverWorkspace(duplicateRoot);
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.problem).toContain("duplicate package root");

  const duplicateNameRoot = workspaceRoot();
  writePackage(duplicateNameRoot, "packages/a", "@fixture/same");
  writePackage(duplicateNameRoot, "packages/b", "@fixture/same");
  writeFileSync(path.join(duplicateNameRoot, "safer-architecture.workspace.json"), JSON.stringify({ packages: ["packages/a", "packages/b"] }));
  const duplicateName = discoverWorkspace(duplicateNameRoot);
  expect(duplicateName.ok).toBe(false);
  if (!duplicateName.ok) expect(duplicateName.problem).toContain("duplicate package name");
});

it("falls back to a named single project when no workspace manifest exists", () => {
  const root = workspaceRoot();
  writePackage(root, ".", "@fixture/root");
  const result = discoverWorkspace(root);
  expect(result).toEqual(expect.objectContaining({
    ok: true,
    workspace: expect.objectContaining({ manifestPath: null }),
  }));
});

it("merges project reports, snapshots, and deterministic package cycles", () => {
  const root = workspaceRoot();
  writePackage(root, "packages/a", "@fixture/a", "@fixture/b");
  writePackage(root, "packages/b", "@fixture/b", "@fixture/a");
  writeFileSync(
    path.join(root, "safer-architecture.workspace.json"),
    JSON.stringify({ packages: ["packages/b", "packages/a"] }),
  );

  const result = spawnSync(process.execPath, [BIN, "check", root, "--json"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout) as {
    projects: readonly { name: string }[];
    diagnostics: readonly { ruleId: string; message: string }[];
    snapshots: readonly { projectRoot: string; sourceFiles: readonly string[] }[];
  };
  expect(report.projects.map(({ name }) => name)).toEqual(["@fixture/a", "@fixture/b"]);
  expect(report.diagnostics).toContainEqual(expect.objectContaining({
    ruleId: "no-workspace-package-cycle",
    message: expect.stringContaining("@fixture/a -> @fixture/b -> @fixture/a"),
  }));
  expect(report.snapshots).toHaveLength(2);
  expect(report.snapshots.every((snapshot) => snapshot.sourceFiles.length === 1)).toBe(true);
});

it("blocks the whole workspace when one package config is invalid", () => {
  const root = workspaceRoot();
  writePackage(root, "packages/a", "@fixture/a");
  writePackage(root, "packages/b", "@fixture/b");
  writeFileSync(
    path.join(root, "safer-architecture.workspace.json"),
    JSON.stringify({ packages: ["packages/a", "packages/b"] }),
  );
  writeFileSync(path.join(root, "packages/b/safer-architecture.config.json"), "{");

  const result = spawnSync(process.execPath, [BIN, "check", root], { encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("packages/b");
  expect(result.stdout).toBe("");
});

function workspaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "safer-arch-workspace-"));
  roots.push(root);
  return root;
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
