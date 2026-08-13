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

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- the bin reads its config before building the Effect runtime; adding @effect/platform as a runtime dependency for one read would weigh on every consumer.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createConnection,
  ProposedFeatures,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver/node.js";
import { WORKSPACE_FILE_NAME } from "../analyzer/workspace/index.js";
import { CONFIG_FILE_NAME } from "./config-loader.js";
import { makeLspServer } from "./lsp-server.js";
import {
  analyzeWorkspaceRoot,
  type WorkspaceArchitectureReport,
} from "./workspace-report.js";

const PACKAGE_VERSION: string = (
  // package.json ships inside this package, so the publish pipeline
  // guarantees `version` is present and the assertion is safe.
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
                 Reads ${WORKSPACE_FILE_NAME}, or ${CONFIG_FILE_NAME} for a single project.
                 Exit codes: 0 clean · 1 findings · 2 could-not-analyze.
    --json       Emit the full report (diagnostics + waivers) as JSON.
    --waivers    List granted suppressions (file, rule, reason).
  serve          Run the stdio Language Server (editors / agent hosts).

DOCS
  https://github.com/chughtapan/safer-architecture-lsp
`;

function main(): void {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- argv is read once at the process boundary to pick a subcommand; @effect/cli would add a runtime dependency to parse two flags.
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
  Effect.runPromise(
    Effect.scoped(makeLspServer(connection)).pipe(
      Effect.flatMap((code) => Effect.sync(() => { process.exit(code); })),
    ),
  ).catch(reportFatal);
}

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[safer-architecture-lsp] fatal: ${message}\n`);
  process.exit(1);
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

  const result = analyzeWorkspaceRoot(root);
  if (!result.ok) {
    process.stderr.write(`cannot analyze: ${result.problem}\n`);
    process.exit(2);
  }
  const report = result.report;

  const unavailable = report.diagnostics.filter(
    (d) => d.ruleId === "architecture-analysis-unavailable",
  );
  if (unavailable.length > 0) {
    for (const d of unavailable) {process.stderr.write(`cannot analyze: ${d.message}\n`);}
    process.exit(2);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          version: PACKAGE_VERSION,
          manifestPath: report.manifestPath,
          configSource: report.projects.length === 1
            ? report.projects[0].configSource
            : "workspace",
          projects: report.projects.map((project) => ({
            name: project.name,
            root: project.root,
            configSource: project.configSource,
            diagnostics: project.report.diagnostics,
            waivers: project.report.waivers,
            snapshot: project.report.snapshot,
          })),
          diagnostics: report.diagnostics,
          waivers: report.waivers,
          snapshots: report.snapshots,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    printFindings(report, root);
    if (waivers) {printWaivers(report, root);}
    const fileCount = report.diagnosticsByFile.size;
    process.stdout.write(
      `safer-architecture check: ${report.diagnostics.length} finding(s) across ${fileCount} file(s), ${report.waivers.length} waiver(s), ${report.projects.length} project(s), options from ${report.projects.length === 1 ? report.projects[0].configSource : "workspace"} — ${root}\n`,
    );
  }
  process.exit(report.diagnostics.length > 0 ? 1 : 0);
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
    if (arg === "--json") {json = true;}
    else if (arg === "--waivers") {waivers = true;}
    else if (arg.startsWith("--")) {return null;}
    else if (!sawRoot) {
      root = path.resolve(arg);
      sawRoot = true;
    } else {return null;}
  }
  return { root, json, waivers };
}

function printFindings(report: WorkspaceArchitectureReport, root: string): void {
  for (const d of report.diagnostics) {
    const rel = path.relative(root, d.file) || d.file;
    process.stdout.write(`${d.severity} ${d.ruleId} ${rel}: ${d.message}\n`);
  }
}

function printWaivers(report: WorkspaceArchitectureReport, root: string): void {
  if (report.waivers.length === 0) {
    process.stdout.write("no waivers granted\n");
    return;
  }
  for (const w of report.waivers) {
    const rel = path.relative(root, w.file) || w.file;
    process.stdout.write(`waived ${w.ruleId} ${rel}: ${w.reason}\n`);
  }
}

main();
