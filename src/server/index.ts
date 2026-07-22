#!/usr/bin/env node

/**
 * @file `safer-architecture-lsp` CLI bin. Builds a stdio LSP connection,
 * boots the Effect-shaped server inside `Effect.scoped`, and runs
 * forever (until the parent process closes stdin/stdout).
 */

import { Effect } from "effect";
import {
  ProposedFeatures,
  StreamMessageReader,
  StreamMessageWriter,
  createConnection,
} from "vscode-languageserver/node.js";
import { makeLspServer } from "./lsp-server.js";

function reportFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[safer-architecture-lsp] fatal: ${message}\n`);
  process.exit(1);
}

function main(): void {
  // Use explicit stream readers/writers on process stdio so the bin
  // works under Claude Code's plugin runtime (which spawns us with
  // no transport flags) and under direct invocation alike.
  const connection = createConnection(
    ProposedFeatures.all,
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );
  // Effect.scoped owns the workspace engines' watchers + caches; when
  // the parent process closes stdio Bun exits and the scope's
  // finalizers run for cleanup.
  Effect.runPromise(Effect.scoped(makeLspServer(connection))).catch(reportFatal);
}

main();
