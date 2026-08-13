#!/usr/bin/env node

/**
 * @file `safer-lsp-proxy` CLI. Reads a JSON backend config (an array of
 * `{cmd, args?}`, first entry primary), multiplexes the client's stdio
 * across the backends, and exits with the primary's code. `--help` and
 * `--version` short-circuit before any backend is spawned.
 */

import { Effect } from "effect";
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
  return (
    // Safe: the required path is this package's own manifest, whose `version`
    // npm guarantees to be a string.
    createRequire(import.meta.url)("../../package.json") as { version: string }
  ).version;
}

function main(argv: string[]): Effect.Effect<number> {
  return Effect.gen(function* () {
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

    const outcome = yield* Effect.try({
      try: () => readBackendSpecs(positional[0]),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((specs) => ({ ok: true as const, specs })),
      // A bad config is a usage error and exits 2; anything else out of
      // `readBackendSpecs` is a bug, so it stays a defect and exits 1.
      Effect.catchAll((cause) =>
        cause instanceof ConfigurationError
          ? Effect.succeed({ ok: false as const, message: cause.message })
          : Effect.die(cause),
      ),
    );
    if (!outcome.ok) {
      log(outcome.message);
      return 2;
    }

    const multiplexer = new Multiplexer(outcome.specs, {
      name: "safer-lsp-proxy",
      version: packageVersion(),
    });
    const onSignal = (): void => { multiplexer.requestStop(); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return yield* multiplexer.run(process.stdin, process.stdout).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }),
      ),
    );
  });
}

Effect.runPromise(
  main(process.argv).pipe(Effect.flatMap((code) => Effect.sync(() => { process.exit(code); }))),
).catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
