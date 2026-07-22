/**
 * @file Temp-directory fixture builder for analyzer tests. Each fixture
 * is a minimal TypeScript project (tsconfig + source files) written to
 * a fresh directory under the OS temp root; callers get the project
 * root and a cleanup handle.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

export interface Fixture {
  readonly root: string;
  readonly cleanup: () => void;
}

export function makeFixture(files: Readonly<Record<string, string>>): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "safer-arch-lsp-"));
  writeFileSync(path.join(root, "tsconfig.json"), FIXTURE_TSCONFIG);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
