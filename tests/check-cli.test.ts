/**
 * @file `check` exit-code contract: 0 clean, 1 findings, 2
 * could-not-analyze (bad root, invalid config, unusable tsconfig) —
 * plus the summary line and the machine/waiver outputs.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeFixture, type Fixture } from "./support/fixtures.js";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const BIN = path.resolve("dist/server/index.js");

function runCheck(args: readonly string[]) {
  return spawnSync(process.execPath, [BIN, "check", ...args], {
    encoding: "utf8" as const,
  });
}

it("exits 0 with a summary line on a clean project", () => {
  fixture = makeFixture({ "core/index.ts": "export const answer: number = 42;\n" });
  const result = runCheck([fixture.root]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("0 finding(s)");
  expect(result.stdout).toContain("options from defaults");
});

it("exits 1 and prints findings on a cyclic project", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const result = runCheck([fixture.root]);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("no-folder-cycle");
});

it("exits 2 when the root is not a directory", () => {
  const result = runCheck(["/nonexistent/definitely-not-here"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("cannot analyze");
});

it("exits 2 when the config file is invalid", () => {
  fixture = makeFixture({ "core/index.ts": "export const answer: number = 42;\n" });
  writeFileSync(
    path.join(fixture.root, "safer-architecture.config.json"),
    "{ not valid json",
  );
  const result = runCheck([fixture.root]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("safer-architecture.config.json");
});

it("exits 2 with a named cause when no tsconfig exists", () => {
  const bare = mkdtempSync(path.join(tmpdir(), "safer-arch-no-tsconfig-"));
  writeFileSync(path.join(bare, "index.ts"), "export const x = 1;\n");
  try {
    const result = runCheck([bare]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no tsconfig.json");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

it("honors config thresholds from safer-architecture.config.json", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  writeFileSync(
    path.join(fixture.root, "safer-architecture.config.json"),
    JSON.stringify({ sharedFolderNames: [{ folder: "beta", reason: "test kernel" }] }),
  );
  const result = runCheck([fixture.root, "--json"]);
  const parsed = JSON.parse(result.stdout) as { configSource: string };
  expect(parsed.configSource).toBe("file");
});

it("lists the waiver ledger with --waivers", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      "// safer-arch-ignore no-folder-cycle: pinned by the cli contract test.\n" +
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const result = runCheck([fixture.root, "--waivers"]);
  expect(result.stdout).toContain("waived no-folder-cycle");
  expect(result.stdout).toContain("pinned by the cli contract test.");
});

it("never hangs on a bare invocation: prints help and exits 2", () => {
  const result = spawnSync(process.execPath, [BIN], { encoding: "utf8" as const, timeout: 10_000 });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("USAGE");
});

it("answers --version with the package version", () => {
  const result = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" as const });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});
