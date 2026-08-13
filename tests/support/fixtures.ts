/**
 * @file Temp-directory fixture builder for analyzer and server tests. Each
 * fixture is a minimal TypeScript project (tsconfig + source files) written
 * to a fresh directory under the OS temp root; callers get the project root
 * and a cleanup handle. This module is the only place the tests touch the
 * filesystem directly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
  },
  include: ["**/*.ts"],
});

/** A throwaway project on disk plus the handle that deletes it. */
export interface Fixture {
  readonly root: string;
  readonly cleanup: () => void;
}

/**
 * Write a throwaway TypeScript project to a fresh temp directory.
 * A strict NodeNext tsconfig is always written first, so callers supply only
 * the sources under test, and nested directories in the keys are created.
 * @param files Source contents keyed by path relative to the project root.
 * @returns The project root and a cleanup handle the caller must invoke.
 */
export function makeFixture(files: Readonly<Record<string, string>>): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "safer-arch-lsp-"));
  writeFileSync(path.join(root, "tsconfig.json"), FIXTURE_TSCONFIG);
  for (const [relative, content] of Object.entries(files)) {
    writeFixtureFile(root, relative, content);
  }
  return { root, cleanup: () => { rmSync(root, { recursive: true, force: true }); } };
}

/**
 * Create a fresh temp directory holding a single named file.
 * @param prefix Prefix for the generated temp directory name.
 * @param name File name to create inside it.
 * @param content Exact bytes to write.
 * @returns The absolute path of the written file.
 */
export function makeTempFile(prefix: string, name: string, content: string): string {
  return writeFixtureFile(mkdtempSync(path.join(tmpdir(), prefix)), name, content);
}

/**
 * Write or overwrite one file inside an existing fixture directory.
 * @param root Directory the path is relative to.
 * @param relative Path of the file relative to `root`; parents are created.
 * @param content Exact bytes to write, including deliberately invalid ones.
 * @returns The absolute path that was written.
 */
export function writeFixtureFile(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}
