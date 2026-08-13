/**
 * @file `check` exit-code contract: 0 clean, 1 findings, 2
 * could-not-analyze (bad root, invalid config, unusable tsconfig) —
 * plus the summary line and the machine/waiver outputs.
 */

import * as fc from "effect/FastCheck";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ArchitectureDiagnosticRuleId } from "../src/index.js";
import { CONFIG_FILE_NAME, type LoadedWorkspaceConfig } from "../src/server/config-loader.js";
import { type Fixture, makeFixture } from "./support/fixtures.js";

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

const BIN = path.resolve("dist/server/index.js");

/** The three exit codes the `check` subcommand documents as its contract. */
const EXIT_CLEAN = 0;
const EXIT_FINDINGS = 1;
const EXIT_CANNOT_ANALYZE = 2;

/** Rule and config vocabulary the CLI echoes back, pinned to the source contract. */
const FOLDER_CYCLE_RULE: ArchitectureDiagnosticRuleId = "no-folder-cycle";
const CONFIG_SOURCE_FILE: LoadedWorkspaceConfig["source"] = "file";
const CONFIG_SOURCE_DEFAULTS: LoadedWorkspaceConfig["source"] = "defaults";

/** Fragments of the human-readable outputs the CLI contract promises. */
const CLEAN_FINDING_COUNT = 0;
const CLEAN_FINDINGS_SUMMARY = `${CLEAN_FINDING_COUNT} finding(s)`;
const DEFAULTS_OPTIONS_SUMMARY = `options from ${CONFIG_SOURCE_DEFAULTS}`;
const CANNOT_ANALYZE_PREFIX = "cannot analyze";
const MISSING_TSCONFIG_CAUSE = "no tsconfig.json";
const USAGE_HEADING = "USAGE";
const WAIVER_REASON = "pinned by the cli contract test.";
const WAIVED_FOLDER_CYCLE = `waived ${FOLDER_CYCLE_RULE}`;

/** The `--`-prefixed flags `check` recognizes; every other one is a usage error. */
const RECOGNIZED_CHECK_FLAGS: ReadonlySet<string> = new Set(["json", "waivers"]);

function runCheck(args: readonly string[]) {
  return spawnSync(process.execPath, [BIN, "check", ...args], {
    encoding: "utf8" as const,
  });
}

it("exits 0 with a summary line on a clean project", () => {
  fixture = makeFixture({ "core/index.ts": "export const answer: number = 42;\n" });
  const result = runCheck([fixture.root]);
  expect(result.status).toBe(EXIT_CLEAN);
  // A clean run must still print a summary, so "analyzed and found nothing"
  // is distinguishable from "never ran"; the count is the proof it ran.
  expect(result.stdout).toContain(CLEAN_FINDINGS_SUMMARY);
  // No config file exists in the fixture, so the summary must name defaults
  // as the option source rather than silently implying a config was read.
  expect(result.stdout).toContain(DEFAULTS_OPTIONS_SUMMARY);
});

it("exits 1 and prints findings on a cyclic project", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const result = runCheck([fixture.root]);
  expect(result.status).toBe(EXIT_FINDINGS);
  // alpha and beta import each other across folder boundaries, which is
  // exactly the edge `no-folder-cycle` exists to report.
  expect(result.stdout).toContain(FOLDER_CYCLE_RULE);
});

it("exits 2 when the root is not a directory", () => {
  const result = runCheck(["/nonexistent/definitely-not-here"]);
  expect(result.status).toBe(EXIT_CANNOT_ANALYZE);
  // A missing root means no analysis happened; the CLI must say so on stderr
  // instead of reporting the unanalyzable project as clean.
  expect(result.stderr).toContain(CANNOT_ANALYZE_PREFIX);
});

it("exits 2 when the config file is invalid", () => {
  fixture = makeFixture({ "core/index.ts": "export const answer: number = 42;\n" });
  writeFileSync(
    path.join(fixture.root, CONFIG_FILE_NAME),
    "{ not valid json",
  );
  const result = runCheck([fixture.root]);
  expect(result.status).toBe(EXIT_CANNOT_ANALYZE);
  // The unusable file has to be named on stderr, or a typo in the config
  // would quietly relax rules with no way to trace which file caused it.
  expect(result.stderr).toContain(CONFIG_FILE_NAME);
});

it("exits 2 with a named cause when no tsconfig exists", () => {
  const bare = mkdtempSync(path.join(tmpdir(), "safer-arch-no-tsconfig-"));
  writeFileSync(path.join(bare, "index.ts"), "export const x = 1;\n");
  try {
    const result = runCheck([bare]);
    expect(result.status).toBe(EXIT_CANNOT_ANALYZE);
    // Analysis needs a TypeScript project; the missing tsconfig is the named
    // cause so the operator can fix it rather than guess why exit 2 happened.
    expect(result.stderr).toContain(MISSING_TSCONFIG_CAUSE);
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
    path.join(fixture.root, CONFIG_FILE_NAME),
    JSON.stringify({ sharedFolderNames: [{ folder: "beta", reason: "test kernel" }] }),
  );
  const result = runCheck([fixture.root, "--json"]);
  const parsed =
    // Safe because `--json` is the CLI's machine contract: the printer always
    // writes configSource, so the field is guaranteed present on a status-0 run.
    JSON.parse(result.stdout) as { configSource: LoadedWorkspaceConfig["source"] };
  // A config file was written at the root, so the loader must report the file
  // as the option source — reporting defaults would mean the config was ignored.
  expect(parsed.configSource).toBe(CONFIG_SOURCE_FILE);
});

it("lists the waiver ledger with --waivers", () => {
  fixture = makeFixture({
    "alpha/index.ts":
      `// safer-arch-ignore ${FOLDER_CYCLE_RULE}: ${WAIVER_REASON}\n` +
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const result = runCheck([fixture.root, "--waivers"]);
  // The directive suppressed the cycle, so the ledger must show it as waived
  // rather than dropping it: a silenced rule stays visible.
  expect(result.stdout).toContain(WAIVED_FOLDER_CYCLE);
  // The reason text is carried verbatim, which is what makes a waiver auditable.
  expect(result.stdout).toContain(WAIVER_REASON);
});

it("never hangs on a bare invocation: prints help and exits 2", () => {
  const result = spawnSync(process.execPath, [BIN], { encoding: "utf8" as const, timeout: 10_000 });
  expect(result.status).toBe(EXIT_CANNOT_ANALYZE);
  // A bare invocation must not block on stdio waiting for LSP traffic; help on
  // stderr is the evidence the process chose to exit instead of listening.
  expect(result.stderr).toContain(USAGE_HEADING);
});

it("answers --version with the package version", () => {
  const result = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" as const });
  expect(result.status).toBe(EXIT_CLEAN);
  // --version is a query, not an analysis, so it exits clean with a bare semver.
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

/**
 * The flag parser is a whitelist: `--json` and `--waivers` are recognized and
 * every other `--` argument is a usage error. The examples above only ever
 * pass recognized flags, so this pins the rejecting branch across arbitrary
 * flag names instead of one hand-picked typo.
 */
it("rejects every unrecognized check flag with the could-not-analyze code and usage text", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/).filter(
        (name) => !RECOGNIZED_CHECK_FLAGS.has(name),
      ),
      (flagName) => {
        const result = runCheck([`--${flagName}`]);
        // An invocation that could not be parsed never ran the analyzer, so it
        // owes the could-not-analyze code — exit 0 here would report a clean
        // project that was never looked at.
        expect(result.status).toBe(EXIT_CANNOT_ANALYZE);
        // Help goes to stderr on the error path so a CI log shows the valid flags.
        expect(result.stderr).toContain(USAGE_HEADING);
      },
    ),
    { numRuns: 6 },
  );
});
