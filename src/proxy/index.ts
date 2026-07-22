#!/usr/bin/env node

/**
 * @file `safer-lsp-proxy` CLI. Reads a JSON backend config (an array of
 * `{cmd, args?}`, first entry primary), multiplexes the client's stdio
 * across the backends, and exits with the primary's code. `--help` and
 * `--version` short-circuit before any backend is spawned.
 */

import { createRequire } from "node:module";
import { ConfigurationError, readBackendSpecs } from "./config.js";
import { log } from "./log.js";
import { Multiplexer } from "./multiplexer.js";

const USAGE = `Usage: safer-lsp-proxy <config.json>

Multiplex one stdio LSP client across a primary language server and any
number of diagnostics sidecars. The config is a non-empty JSON array of
{"cmd": string, "args"?: string[]} objects; the first entry is the
primary, the rest are sidecars.

Options:
  -h, --help     Show this help and exit
  -V, --version  Print the version and exit
`;

function packageVersion(): string {
  return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.includes("-V") || args.includes("--version")) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length !== 1) {
    log("usage: safer-lsp-proxy <config.json>");
    return 2;
  }

  let specs;
  try {
    specs = readBackendSpecs(positional[0]);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      log(error.message);
      return 2;
    }
    throw error;
  }

  const multiplexer = new Multiplexer(specs, {
    name: "safer-lsp-proxy",
    version: packageVersion(),
  });
  const onSignal = (): void => multiplexer.requestStop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await multiplexer.run(process.stdin, process.stdout);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
