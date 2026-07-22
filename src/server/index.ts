#!/usr/bin/env node

/**
 * @file `safer-architecture-lsp` CLI bin.
 *
 * Subcommands:
 * - `check [root]` — one-shot analysis for CI and agents. Exit 0 on a
 *   clean run, 1 when findings exist, 2 when the run itself could not
 *   analyze (bad root, invalid config, unusable tsconfig). Always
 *   prints a summary line, so an empty-clean result is distinguishable
 *   from a run that never happened. `--json` emits the machine shape;
 *   `--waivers` lists the reason-carrying suppression ledger.
 * - `serve` — the stdio LSP server (editors, agent harnesses).
 * - `--help` / `--version` — never hang; a bare invocation prints help
 *   and exits 2 instead of silently blocking on stdio.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  ProposedFeatures,
  StreamMessageReader,
  StreamMessageWriter,
  createConnection,
} from "vscode-languageserver/node.js";
import { makeLspServer } from "./lsp-server.js";
import { CONFIG_FILE_NAME, loadWorkspaceConfig } from "./config-loader.js";
import { analyzeResolvedArchitecture } from "../analyzer/index.js";
import {
  resolveArchitectureOptions,
  type ArchitectureReport,
} from "../analyzer/project/api/index.js";

const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

const HELP = `safer-architecture-lsp ${PACKAGE_VERSION}
Whole-project TypeScript architecture analyzer.

USAGE
  safer-architecture-lsp check [root] [--json] [--waivers]
  safer-architecture-lsp serve
  safer-architecture-lsp --help | --version

COMMANDS
  check [root]   Analyze the project at root (default: cwd) once and exit.
                 Reads ${CONFIG_FILE_NAME} at the root when present.
                 Exit codes: 0 clean · 1 findings · 2 could-not-analyze.
    --json       Emit the full report (diagnostics + waivers) as JSON.
    --waivers    List granted suppressions (file, rule, reason).
  serve          Run the stdio Language Server (editors / agent hosts).

DOCS
  https://github.com/chughtapan/safer-architecture-lsp
`;

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[safer-architecture-lsp] fatal: ${message}\n`);
  process.exit(1);
}

function serve(): void {
  // Use explicit stream readers/writers on process stdio so the bin
  // works under Claude Code's plugin runtime (which spawns us with
  // no transport flags) and under direct invocation alike.
  const connection = createConnection(
    ProposedFeatures.all,
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );
  // Effect.scoped owns the workspace engines' watchers + caches; the
  // server Effect completes on the protocol `exit` notification and the
  // scope's finalizers run before the process ends.
  Effect.runPromise(Effect.scoped(makeLspServer(connection)))
    .then((code) => process.exit(code))
    .catch(reportFatal);
}

interface CheckFlags {
  readonly root: string;
  readonly json: boolean;
  readonly waivers: boolean;
}

function parseCheckFlags(args: readonly string[]): CheckFlags | null {
  let root = process.cwd();
  let json = false;
  let waivers = false;
  let sawRoot = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--waivers") waivers = true;
    else if (arg.startsWith("--")) return null;
    else if (!sawRoot) {
      root = path.resolve(arg);
      sawRoot = true;
    } else return null;
  }
  return { root, json, waivers };
}

function printFindings(report: ArchitectureReport, root: string): void {
  for (const d of report.diagnostics) {
    const rel = path.relative(root, d.file) || d.file;
    process.stdout.write(`${d.severity} ${d.ruleId} ${rel}: ${d.message}\n`);
  }
}

function printWaivers(report: ArchitectureReport, root: string): void {
  if (report.waivers.length === 0) {
    process.stdout.write("no waivers granted\n");
    return;
  }
  for (const w of report.waivers) {
    const rel = path.relative(root, w.file) || w.file;
    process.stdout.write(`waived ${w.ruleId} ${rel}: ${w.reason}\n`);
  }
}

function check(args: readonly string[]): void {
  const flags = parseCheckFlags(args);
  if (flags === null) {
    process.stderr.write(`unrecognized check arguments: ${args.join(" ")}\n\n${HELP}`);
    process.exit(2);
  }
  const { root, json, waivers } = flags;

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(
      `cannot analyze: ${root} is not a directory. Pass a project root containing a tsconfig.json.\n`,
    );
    process.exit(2);
  }

  const config = loadWorkspaceConfig(root);
  if (config.problem !== null) {
    // CI must never silently fall back to defaults: a broken config is
    // a failed run, not a differently-configured one.
    process.stderr.write(
      `cannot analyze: ${CONFIG_FILE_NAME} at ${root} is invalid: ${config.problem}\n`,
    );
    process.exit(2);
  }

  const options = resolveArchitectureOptions({ ...config.options, projectRoot: root });
  const report = analyzeResolvedArchitecture(options);

  const unavailable = report.diagnostics.filter(
    (d) => d.ruleId === "architecture-analysis-unavailable",
  );
  if (unavailable.length > 0) {
    for (const d of unavailable) process.stderr.write(`cannot analyze: ${d.message}\n`);
    process.exit(2);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          version: PACKAGE_VERSION,
          configSource: config.source,
          diagnostics: report.diagnostics,
          waivers: report.waivers,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printFindings(report, root);
    if (waivers) printWaivers(report, root);
    const fileCount = report.diagnosticsByFile.size;
    process.stdout.write(
      `safer-architecture check: ${report.diagnostics.length} finding(s) across ${fileCount} file(s), ${report.waivers.length} waiver(s), options from ${config.source} — ${root}\n`,
    );
  }
  process.exit(report.diagnostics.length > 0 ? 1 : 0);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve":
      serve();
      return;
    case "check":
      check(rest);
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exit(0);
      break;
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      process.exit(0);
      break;
    default:
      process.stderr.write(HELP);
      process.exit(2);
  }
}

main();
