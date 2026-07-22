/**
 * @file Long-lived per-workspace engine that the LSP server consumes.
 * Effect-shaped: the file watcher and PubSub are acquired through a
 * `Scope` (callers wrap with `Effect.scoped` so the engine cannot leak
 * resources), and `lintPaths` returns an `Effect` so callers can
 * compose it with the rest of the LSP pipeline. Wraps the
 * `WorkspaceCache` (Phase 5b) without changing it.
 */

import path from "node:path";
import { type FSWatcher, watch as chokidarWatch } from "chokidar";
import { Data, Effect, PubSub, Scope, Stream } from "effect";
import type ts from "typescript";
import {
  clearWorkspaceCache,
  getOrCreateWorkspaceCache,
} from "../analyzer/project/cache/index.js";
import type {
  ArchitectureDiagnostic,
  ResolvedArchitectureOptions,
} from "../analyzer/project/api/index.js";

/** Tag for engine-internal failure modes. */
class WorkspaceEngineError extends Data.TaggedError("WorkspaceEngineError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const IGNORED_SEGMENTS = ["node_modules", ".cache", "dist", "coverage"];
const ANALYZER_INPUT_SUFFIXES = [".ts", ".tsx", ".mts", ".cts"];
const ANALYZER_INPUT_BASENAMES = new Set(["package.json"]);
const TSCONFIG_PREFIX = "tsconfig";

function isIgnoredPath(filePath: string): boolean {
  for (const segment of IGNORED_SEGMENTS) {
    if (filePath.includes(`${path.sep}${segment}${path.sep}`)) return true;
    if (filePath.endsWith(`${path.sep}${segment}`)) return true;
  }
  return false;
}

function isAnalyzerInput(filePath: string): boolean {
  const base = path.basename(filePath);
  if (ANALYZER_INPUT_BASENAMES.has(base)) return true;
  if (base.startsWith(TSCONFIG_PREFIX) && base.endsWith(".json")) return true;
  for (const suffix of ANALYZER_INPUT_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  return false;
}

/** Public surface of the engine. Created via `makeWorkspaceEngine`. */
export interface WorkspaceEngine {
  /**
   * Look up diagnostics for the requested files. Hits the workspace
   * cache (Phase 5b) and filters `diagnosticsByFile` to the requested
   * set so the caller can `publishDiagnostics` per file.
   * @param paths Absolute file paths.
   * @param programProvider Optional `ts.Program` source (LSP
   * `LanguageService` for overlay support).
   * @param programFingerprint Required when `programProvider` is
   * supplied; stable identifier of the program (e.g., monotonic LSP
   * version) so overlay reports don't collide with the disk-backed one.
   */
  readonly lintPaths: (
    paths: readonly string[],
    programProvider?: () => ts.Program | null,
    programFingerprint?: string,
  ) => Effect.Effect<readonly ArchitectureDiagnostic[], WorkspaceEngineError>;

  /**
   * Stream of cache-invalidation signals. The cache is already cleared
   * by the time a value is emitted; subscribers should re-publish
   * diagnostics for their open documents.
   */
  readonly invalidations: Stream.Stream<void>;

  /** Absolute project root this engine is scoped to. */
  readonly projectRoot: string;
}

const acquireWatcher = (
  projectRoot: string,
): Effect.Effect<FSWatcher, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.async<FSWatcher>((resume) => {
      // chokidar 5.x dropped glob support: watch the project root
      // recursively and filter events in the listener instead.
      const w = chokidarWatch(projectRoot, {
        ignored: (filePath: string): boolean => isIgnoredPath(filePath),
        ignoreInitial: true,
        persistent: true,
      });
      w.on("ready", () => resume(Effect.succeed(w)));
    }),
    (w) =>
      Effect.tryPromise({
        try: () => w.close(),
        catch: (cause) =>
          new WorkspaceEngineError({ message: "watcher.close failed", cause }),
      }).pipe(Effect.orDie),
  );

const wireWatcherToPubSub = (
  watcher: FSWatcher,
  pubsub: PubSub.PubSub<void>,
  projectRoot: string,
): void => {
  const onChange = (filePath: string): void => {
    if (!isAnalyzerInput(filePath)) return;
    clearWorkspaceCache(projectRoot);
    Effect.runFork(PubSub.publish(pubsub, undefined));
  };
  watcher.on("change", onChange);
  watcher.on("add", onChange);
  watcher.on("unlink", onChange);
};

const buildLintPaths =
  (options: ResolvedArchitectureOptions) =>
  (
    paths: readonly string[],
    programProvider?: () => ts.Program | null,
    programFingerprint?: string,
  ): Effect.Effect<readonly ArchitectureDiagnostic[], WorkspaceEngineError> =>
    Effect.try({
      try: () => {
        const cache = getOrCreateWorkspaceCache(options.projectRoot);
        const report = cache.get(options, programProvider, programFingerprint);
        const found: ArchitectureDiagnostic[] = [];
        for (const filePath of paths) {
          const findings = report.diagnosticsByFile.get(path.resolve(filePath));
          if (findings !== undefined) found.push(...findings);
        }
        return found;
      },
      catch: (cause) =>
        new WorkspaceEngineError({
          message: `lintPaths failed for ${options.projectRoot}`,
          cause,
        }),
    });

/**
 * Acquire a workspace engine. The returned `Effect` requires a `Scope`
 * (callers compose with `Effect.scoped` or a `Layer.scoped`); closing
 * the scope releases the watcher and the PubSub, and clears this
 * workspace's cache. No manual `dispose()` to forget.
 * @param options Resolved architecture options for this workspace.
 * @returns Effect producing the engine; depends on a Scope.
 */
export const makeWorkspaceEngine = (
  options: ResolvedArchitectureOptions,
): Effect.Effect<WorkspaceEngine, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<void>();
    const watcher = yield* acquireWatcher(options.projectRoot);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => clearWorkspaceCache(options.projectRoot)),
    );
    wireWatcherToPubSub(watcher, pubsub, options.projectRoot);
    return {
      projectRoot: options.projectRoot,
      invalidations: Stream.fromPubSub(pubsub),
      lintPaths: buildLintPaths(options),
    };
  }).pipe(Effect.withSpan("makeWorkspaceEngine"));
