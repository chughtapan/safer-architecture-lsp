/**
 * @file Stdio LSP server entry. Builds a vscode-languageserver
 * `Connection`, registers handlers wired through Effect so the
 * `WorkspaceEngine` (and its `Scope`-managed watcher + cache) live
 * inside the Effect runtime. The server runs until an `exit`
 * notification (or stdio close); teardown closes the ambient `Scope`
 * so every engine's finalizers run before the process ends.
 *
 * Analysis is save-time: `didChange` updates the document store but
 * doesn't re-lint; `didSave` clears the cache and republishes. The
 * chokidar watcher catches out-of-band edits and the invalidations
 * stream triggers a republish. Diagnostics are published for EVERY
 * analyzed file in the workspace, not only open documents — agents and
 * problem panels need findings for files nobody has opened.
 *
 * Per-workspace configuration is discovered at
 * `safer-architecture.config.json`; edits to it rebuild that
 * workspace's engine in place (child-Scope teardown, no watcher leak).
 */

import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { Data, Deferred, Effect, Ref, Scope, Stream } from "effect";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Connection,
  type Diagnostic,
  DiagnosticSeverity,
  type InitializeParams,
  type InitializeResult,
  type PublishDiagnosticsParams,
  TextDocumentSyncKind,
} from "vscode-languageserver";
import type { WorkspaceEngine } from "./workspace-engine.js";
import { clearWorkspaceCache } from "../analyzer/project/cache/index.js";
import {
  discoverWorkspace,
  WORKSPACE_FILE_NAME,
  workspacePackageCycleDiagnostics,
} from "../analyzer/workspace/index.js";
import { CONFIG_FILE_NAME, loadWorkspaceConfig } from "./config-loader.js";
import { groupByUri } from "./diagnostic-converter.js";
import { type DocumentStore, makeDocumentStore } from "./document-store.js";
import { makeWorkspaceRegistry, type WorkspaceRegistry } from "./workspace-registry.js";

// Resolved at runtime relative to the compiled dist/server/ layout so the
// advertised server version always matches the published package version.
const PACKAGE_VERSION: string = (
  // package.json ships inside this package, so the publish pipeline
  // guarantees `version` is present and the assertion is safe.
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

/** Tag for a config-watcher teardown failure; always surfaced as a defect. */
class WatcherCloseError extends Data.TaggedError("WatcherCloseError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const log = (message: string): void => {
  process.stderr.write(`[safer-architecture-lsp] ${message}\n`);
};

/**
 * Log text for a rejected host call.
 * @param cause Rejection value from the LSP connection or the watcher.
 * @returns The error message, or a fixed string for non-`Error` rejections,
 * so nothing is stringified through `Object.prototype.toString`.
 */
const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "non-Error rejection";

interface ServerDeps {
  readonly connection: Connection;
  readonly docs: DocumentStore;
  readonly registry: WorkspaceRegistry;

  /**
   * Resolves after the workspaces named in `initialize` have been
   * registered. Every text-document handler awaits this so a `didOpen`
   * arriving before registration completes still publishes diagnostics
   * once the engine exists.
   */
  readonly ready: Deferred.Deferred<void>;

  /**
   * URIs this server last published diagnostics for, per workspace
   * root. Publishing a fresh report clears any URI that dropped out of
   * it, so fixed findings never leave stale squiggles behind.
   */
  readonly published: Ref.Ref<
    ReadonlyMap<string, ReadonlyMap<string, readonly Diagnostic[]>>
  >;

  /** Project roots attached for each client workspace folder. */
  readonly workspaceProjects: Ref.Ref<ReadonlyMap<string, readonly string[]>>;

  /** Non-project diagnostics (workspace manifest and package graph), by workspace root. */
  readonly workspacePublished: Ref.Ref<
    ReadonlyMap<string, ReadonlyMap<string, readonly Diagnostic[]>>
  >;

  /** One config-file watcher per workspace root; survives engine reloads. */
  readonly configWatchers: Map<string, FSWatcher>;

  /** Metadata paths currently attached to each watcher. */
  readonly configWatcherPaths: Map<string, ReadonlySet<string>>;

  /** Serialize detach/attach reloads so event bursts cannot leak child scopes. */
  readonly reloadLocks: Map<string, Effect.Semaphore>;

  /** Debounce metadata event bursts per workspace root. */
  readonly reloadTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const findEngineForUri = (
  registry: WorkspaceRegistry,
  uri: string,
): Effect.Effect<WorkspaceEngine | null> =>
  Effect.gen(function* () {
    const filePath = fileURLToPath(uri);
    const roots = yield* registry.listProjectRoots();
    // Pick the longest matching project root so nested workspaces map
    // to the most specific one.
    let best: { root: string; len: number } | null = null;
    for (const root of roots) {
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {continue;}
      if (best === null || root.length > best.len) {best = { root, len: root.length };}
    }
    if (best === null) {return null;}
    return yield* registry.findByProjectRoot(best.root);
  });

const sendDiagnostics = (
  deps: ServerDeps,
  uri: string,
  diagnostics: readonly Diagnostic[],
): Effect.Effect<void> =>
  Effect.sync(() => {
    const params: PublishDiagnosticsParams = { uri, diagnostics: [...diagnostics] };
    // Fire-and-forget, so a publish loop never stalls on the wire. The
    // rejection handler keeps a failed write off the unhandled-rejection
    // path and onto stderr, which is the only stream `serve` can log to.
    deps.connection.sendDiagnostics(params).catch((cause: unknown) => {
      log(`sendDiagnostics failed for ${uri}: ${describeFailure(cause)}`);
    });
  });

const sendMergedDiagnostics = (
  deps: ServerDeps,
  uri: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const projectReports = yield* Ref.get(deps.published);
    const workspaceReports = yield* Ref.get(deps.workspacePublished);
    const diagnostics = [
      ...projectReports.values(),
      ...workspaceReports.values(),
    ].flatMap((report) => report.get(uri) ?? []);
    yield* sendDiagnostics(deps, uri, diagnostics);
  });

/**
 * A file-level error diagnostic built outside the analyzer (config problems, engine crashes).
 * @param code Stable identifier for the failure kind, so clients can group
 * and filter these the way they do analyzer findings.
 * @param message Text shown to the user; says what coverage was lost.
 * @returns A diagnostic anchored to the first character of the file.
 */
const serverErrorDiagnostic = (code: string, message: string): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity: DiagnosticSeverity.Error,
  code,
  source: "safer-architecture",
  message,
});

/**
 * Publish the whole-workspace report: every file with findings gets its
 * diagnostics; every previously-published file that dropped out gets an
 * explicit empty publish so stale squiggles clear. Engine failures are
 * surfaced as an error diagnostic on the workspace's config path —
 * a crashed analysis must never present as "architecture clean".
 * @param deps Holds the connection and the record of what this workspace
 * published last, which decides what has to be cleared.
 * @param engine Workspace whose full report is recomputed now.
 * @returns Effect completing once every affected URI has been sent.
 */
const publishWorkspace = (
  deps: ServerDeps,
  engine: WorkspaceEngine,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const root = engine.projectRoot;
    const outcome = yield* engine.fullReport().pipe(
      Effect.map((report) => ({ ok: true as const, report })),
      Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
    );

    const nextUris = new Map<string, readonly Diagnostic[]>();
    if (outcome.ok) {
      for (const [uri, diagnostics] of groupByUri(outcome.report.diagnostics)) {
        nextUris.set(uri, diagnostics);
      }
    } else {
      const configUri = pathToFileURL(path.join(root, CONFIG_FILE_NAME)).toString();
      nextUris.set(configUri, [
        serverErrorDiagnostic(
          "architecture-analysis-error",
          `Architecture analysis crashed for ${root}: ${String(outcome.error.cause ?? outcome.error.message)}. Until this is fixed the workspace has NO architecture coverage.`,
        ),
      ]);
      yield* Effect.sync(() => { log(`analysis failed for ${root}: ${outcome.error.message}`); });
    }

    const previous =
      (yield* Ref.get(deps.published)).get(root) ??
      new Map<string, readonly Diagnostic[]>();
    const affectedUris = new Set([...previous.keys(), ...nextUris.keys()]);
    yield* Ref.update(deps.published, (map) => {
      const next = new Map(map);
      next.set(root, nextUris);
      return next;
    });
    for (const uri of affectedUris) {yield* sendMergedDiagnostics(deps, uri);}
    yield* Effect.sync(() => {
      if (outcome.ok) {
        log(
          `published ${outcome.report.diagnostics.length} finding(s) across ${nextUris.size} file(s) for ${root} in ${Date.now() - startedAt}ms`,
        );
      }
    });
  });

const handleInitialize = (): InitializeResult => ({
  capabilities: {
    textDocumentSync: {
      openClose: true,
      // didChange stores the full document text; Incremental deltas
      // would corrupt the store, so advertise exactly what is handled.
      change: TextDocumentSyncKind.Full,
      save: { includeText: false },
    },
    workspace: {
      workspaceFolders: {
        supported: true,
        changeNotifications: true,
      },
    },
  },
  serverInfo: { name: "safer-architecture-lsp", version: PACKAGE_VERSION },
});

/**
 * Register (or re-register) one workspace: load its config file, build
 * the engine, surface config problems as a diagnostic on the config
 * file, wire the invalidation stream, and publish the initial report.
 * @param deps Registry the engine is recorded in and connection the
 * initial diagnostics go out on.
 * @param root Project root whose config file and engine are (re)loaded.
 * @returns Effect completing after the first report is published; the
 * required `Scope` owns the engine and its invalidation subscriber.
 */
const attachProject = (
  deps: ServerDeps,
  root: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const config = loadWorkspaceConfig(root);
    const engine = yield* deps.registry.register(root, config.options);
    yield* Effect.sync(() =>
      { log(
        `workspace ${root} registered (options: ${config.source}${config.problem === null ? "" : "; config INVALID, using defaults"})`,
      ); },
    );

    const configUri = pathToFileURL(config.configPath).toString();
    yield* config.problem === null
      ? sendDiagnostics(deps, configUri, [])
      : sendDiagnostics(deps, configUri, [
          serverErrorDiagnostic(
            "invalid-config",
            `${CONFIG_FILE_NAME} is invalid and was ignored (defaults apply): ${config.problem}`,
          ),
        ]);

    // Re-publish when the engine's source watcher fires. The fork dies
    // with the engine's child scope on unregister, so reloads don't
    // accumulate subscribers.
    yield* Effect.forkScoped(
      Stream.runForEach(engine.invalidations, () => publishWorkspace(deps, engine)),
    );
    yield* publishWorkspace(deps, engine);
  });

/**
 * Tear the workspace down and clear everything it ever published.
 * @param deps Source of the project's last published set, which is what
 * has to be republished as empty.
 * @param root Project root to unregister.
 * @returns Effect completing once the engine is released and its
 * squiggles are gone from every file it had touched.
 */
const detachProject = (deps: ServerDeps, root: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const previous =
      (yield* Ref.get(deps.published)).get(root) ??
      new Map<string, readonly Diagnostic[]>();
    yield* Ref.update(deps.published, (map) => {
      const next = new Map(map);
      next.delete(root);
      return next;
    });
    for (const uri of previous.keys()) {yield* sendMergedDiagnostics(deps, uri);}
    yield* deps.registry.unregister(root);
    yield* Effect.sync(() => { log(`workspace ${root} detached`); });
  });

/**
 * Publish the findings that belong to the workspace itself rather than
 * to any one project (bad manifest, package cycles), clearing every URI
 * that dropped out of the previous set. Kept separate from project
 * diagnostics so either side can be replaced without erasing the other.
 * @param deps Holds this root's last workspace-level publish.
 * @param root Client workspace folder the findings are recorded under.
 * @param diagnosticsByUri Findings to publish now, keyed by document URI.
 * @returns Effect completing once every affected URI has been sent.
 */
const publishWorkspaceDiagnostics = (
  deps: ServerDeps,
  root: string,
  diagnosticsByUri: ReadonlyMap<string, readonly Diagnostic[]>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const previous =
      (yield* Ref.get(deps.workspacePublished)).get(root) ??
      new Map<string, readonly Diagnostic[]>();
    const affectedUris = new Set([...previous.keys(), ...diagnosticsByUri.keys()]);
    yield* Ref.update(deps.workspacePublished, (map) => {
      const next = new Map(map);
      next.set(root, diagnosticsByUri);
      return next;
    });
    for (const uri of affectedUris) {yield* sendMergedDiagnostics(deps, uri);}
  });

const attachWorkspaceRoot = (
  deps: ServerDeps,
  root: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const discovery = discoverWorkspace(root);
    if (!discovery.ok) {
      const uri = pathToFileURL(discovery.manifestPath).toString();
      yield* publishWorkspaceDiagnostics(deps, root, new Map([[uri, [
        serverErrorDiagnostic(
          "invalid-workspace-config",
          `${WORKSPACE_FILE_NAME} is invalid: ${discovery.problem}. Until this is fixed the workspace has NO architecture coverage.`,
        ),
      ]]]));
      yield* Ref.update(deps.workspaceProjects, (map) => {
        const next = new Map(map);
        next.set(root, []);
        return next;
      });
      return;
    }

    const projectRoots = discovery.workspace.projects.map((project) => project.root);
    yield* Ref.update(deps.workspaceProjects, (map) => {
      const next = new Map(map);
      next.set(root, projectRoots);
      return next;
    });
    for (const project of discovery.workspace.projects) {
      yield* attachProject(deps, project.root);
    }
    const cycleDiagnostics = groupByUri(
      workspacePackageCycleDiagnostics(discovery.workspace),
    );
    yield* publishWorkspaceDiagnostics(deps, root, cycleDiagnostics);
    yield* Effect.sync(() =>
      { log(`workspace root ${root} attached with ${projectRoots.length} project(s)`); },
    );
  });

const detachWorkspaceRoot = (deps: ServerDeps, root: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const projects = (yield* Ref.get(deps.workspaceProjects)).get(root) ?? [];
    for (const projectRoot of projects) {yield* detachProject(deps, projectRoot);}
    yield* Ref.update(deps.workspaceProjects, (map) => {
      const next = new Map(map);
      next.delete(root);
      return next;
    });
    yield* publishWorkspaceDiagnostics(deps, root, new Map());
    yield* Ref.update(deps.workspacePublished, (map) => {
      const next = new Map(map);
      next.delete(root);
      return next;
    });
  });

const reloadWorkspaceRoot = (
  deps: ServerDeps,
  root: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => { log(`workspace metadata change detected for ${root}; reloading`); });
    yield* detachWorkspaceRoot(deps, root);
    if (!deps.configWatchers.has(root)) {return;}
    yield* attachWorkspaceRoot(deps, root);
    yield* syncWorkspaceWatcherPaths(deps, root);
  });

function workspaceMetadataPaths(root: string): string[] {
  const paths = new Set([
    path.join(root, WORKSPACE_FILE_NAME),
    path.join(root, CONFIG_FILE_NAME),
    path.join(root, "package.json"),
  ]);
  const discovery = discoverWorkspace(root);
  if (discovery.ok) {
    for (const project of discovery.workspace.projects) {
      paths.add(path.join(project.root, CONFIG_FILE_NAME));
      paths.add(project.packageJsonPath);
    }
  }
  // Plain code-unit ordering, matching the default `.sort()` this replaces, so
  // the watched-path set stays byte-identical across locales.
  return [...paths].sort(compareCodeUnits);
}

/**
 * Code-unit string ordering, identical to a comparator-less `.sort()`.
 * @param a Left operand.
 * @param b Right operand.
 * @returns Negative, zero, or positive per the `Array.prototype.sort` contract.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {return -1;}
  if (a > b) {return 1;}
  return 0;
}

// Declared as a hoisted function so `reloadWorkspaceRoot`, which runs after
// the watcher is installed, can call it from above its definition.
function syncWorkspaceWatcherPaths(
  deps: ServerDeps,
  root: string,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const watcher = deps.configWatchers.get(root);
    if (watcher === undefined) {return;}
    const previous = deps.configWatcherPaths.get(root) ?? new Set<string>();
    const next = new Set(workspaceMetadataPaths(root));
    const removed = [...previous].filter((candidate) => !next.has(candidate));
    const added = [...next].filter((candidate) => !previous.has(candidate));
    // chokidar 5's `unwatch`/`add` are synchronous and return the watcher.
    if (removed.length > 0) {watcher.unwatch(removed);}
    if (added.length > 0) {watcher.add(added);}
    deps.configWatcherPaths.set(root, next);
  });
}

function scheduleWorkspaceReload(
  deps: ServerDeps,
  root: string,
  runInScope: (effect: Effect.Effect<void, never, Scope.Scope>) => void,
): void {
  const previous = deps.reloadTimers.get(root);
  if (previous !== undefined) {clearTimeout(previous);}
  const timer = setTimeout(() => {
    deps.reloadTimers.delete(root);
    const lock = deps.reloadLocks.get(root);
    if (lock === undefined || !deps.configWatchers.has(root)) {return;}
    runInScope(lock.withPermits(1)(reloadWorkspaceRoot(deps, root)));
  }, 75);
  deps.reloadTimers.set(root, timer);
}

/**
 * Watch the workspace's config file so edits take effect without a
 * server restart. The watcher lives outside the engine's child scope
 * (it triggers engine replacement) and is closed on detach/shutdown.
 * @param deps Where the watcher, its debounce timer, and the lock that
 * serializes reloads are registered.
 * @param root Workspace root whose manifest, config, and package files
 * are watched, including those of its member projects.
 * @param runInScope Escape hatch for the chokidar callback, which has no
 * Effect context of its own, to run a reload under the server's scope.
 * @returns Effect that installs the watcher and closes it on release.
 */
const watchWorkspaceConfig = (
  deps: ServerDeps,
  root: string,
  runInScope: (effect: Effect.Effect<void, never, Scope.Scope>) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const watchedPaths = workspaceMetadataPaths(root);
      const watcher = chokidarWatch(watchedPaths, {
        ignoreInitial: true,
        persistent: true,
      });
      const onEvent = (): void => { scheduleWorkspaceReload(deps, root, runInScope); };
      watcher.on("add", onEvent);
      watcher.on("change", onEvent);
      watcher.on("unlink", onEvent);
      deps.configWatchers.set(root, watcher);
      deps.configWatcherPaths.set(root, new Set(watchedPaths));
      if (!deps.reloadLocks.has(root)) {
        deps.reloadLocks.set(root, Effect.unsafeMakeSemaphore(1));
      }
      return watcher;
    }),
    (watcher) =>
      Effect.suspend(() => {
        const timer = deps.reloadTimers.get(root);
        if (timer !== undefined) {clearTimeout(timer);}
        deps.reloadTimers.delete(root);
        deps.configWatcherPaths.delete(root);
        deps.reloadLocks.delete(root);
        // Same shape as the engine's watcher release: a close failure is a
        // defect, never a recoverable error, so release stays `never`-failing.
        return Effect.tryPromise({
          try: () => watcher.close(),
          catch: (cause) =>
            new WatcherCloseError({ message: `watcher.close failed for ${root}`, cause }),
        }).pipe(Effect.orDie);
      }),
  ).pipe(Effect.asVoid);

/**
 * The single-root fields `initialize` carried before workspace folders
 * existed. The protocol retired both in favour of `workspaceFolders`, but
 * plenty of clients still send only these, and total silence for them would
 * be indistinguishable from a clean workspace — so the server reads them
 * through this narrow structural view of `InitializeParams`.
 */
interface LegacyInitializeRoots {
  readonly rootUri?: string | null;
  readonly rootPath?: string | null;
}

const workspaceRootsFrom = (params: InitializeParams): readonly string[] => {
  const folders = params.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders.map((folder) => fileURLToPath(folder.uri));
  }
  const legacy: LegacyInitializeRoots = params;
  if (legacy.rootUri) {return [fileURLToPath(legacy.rootUri)];}
  if (legacy.rootPath) {return [path.resolve(legacy.rootPath)];}
  return [];
};

const registerInitialWorkspaces = (
  deps: ServerDeps,
  params: InitializeParams,
  runInScope: (effect: Effect.Effect<void, never, Scope.Scope>) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const roots = workspaceRootsFrom(params);
    if (roots.length === 0) {
      yield* Effect.sync(() =>
        { log("no workspace folders, rootUri, or rootPath in initialize; nothing to analyze"); },
      );
    }
    for (const root of roots) {
      yield* attachWorkspaceRoot(deps, root);
      yield* watchWorkspaceConfig(deps, root, runInScope);
    }
  });

const handleDidOpen = (
  deps: ServerDeps,
  td: { uri: string; languageId: string; version: number; text: string },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* deps.docs.open(td);
    yield* Deferred.await(deps.ready);
    const engine = yield* findEngineForUri(deps.registry, td.uri);
    if (engine === null) {return;}
    yield* publishWorkspace(deps, engine);
  });

const handleDidSave = (
  deps: ServerDeps,
  uri: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Deferred.await(deps.ready);
    const engine = yield* findEngineForUri(deps.registry, uri);
    if (engine === null) {return;}
    // Force-invalidate so the next lint sees the saved content, even
    // if the watcher is slower than our handler.
    yield* Effect.sync(() => { clearWorkspaceCache(engine.projectRoot); });
    yield* publishWorkspace(deps, engine);
  });

const handleDidClose = (deps: ServerDeps, uri: string): Effect.Effect<void> =>
  // The document store forgets the buffer, but published diagnostics
  // stay: findings for a file exist whether or not it is open.
  deps.docs.close(uri);

const setupTextHandlers = (deps: ServerDeps): void => {
  deps.connection.onInitialized(() => {
    // Initial workspace registration is wired in the Effect program
    // (see makeLspServer). Nothing to do here yet.
  });

  deps.connection.onDidOpenTextDocument((params) => {
    Effect.runFork(handleDidOpen(deps, params.textDocument));
  });

  deps.connection.onDidChangeTextDocument((params) => {
    const last = params.contentChanges.at(-1);
    if (last === undefined || !("text" in last)) {return;}
    // Full sync: the last change carries the whole document.
    Effect.runFork(
      deps.docs.update(params.textDocument.uri, params.textDocument.version, last.text),
    );
  });

  deps.connection.onDidSaveTextDocument((params) => {
    Effect.runFork(handleDidSave(deps, params.textDocument.uri));
  });

  deps.connection.onDidCloseTextDocument((params) => {
    Effect.runFork(handleDidClose(deps, params.textDocument.uri));
  });

};

/**
 * Folder add/remove handling. Registered only when the client
 * advertised `workspace.workspaceFolders` support — the vscode
 * languageserver workspace proxy throws otherwise.
 * @param deps Server state each added folder is attached to and each
 * removed folder — watcher, timer, and lock included — is stripped from.
 * @param runInScope Runs the attach or detach work under the server's
 * scope, since the folder-change callback is outside the Effect runtime.
 */
const setupWorkspaceFolderHandler = (
  deps: ServerDeps,
  runInScope: (effect: Effect.Effect<void, never, Scope.Scope>) => void,
): void => {
  deps.connection.workspace.onDidChangeWorkspaceFolders((event) => {
    for (const removed of event.removed) {
      const root = fileURLToPath(removed.uri);
      const watcher = deps.configWatchers.get(root);
      deps.configWatchers.delete(root);
      const timer = deps.reloadTimers.get(root);
      if (timer !== undefined) {clearTimeout(timer);}
      deps.reloadTimers.delete(root);
      if (watcher) {
        // Detached on purpose: the folder-change callback must return before
        // the close settles. Failures go to stderr, never stdout.
        watcher.close().catch((cause: unknown) => {
          log(`watcher close failed for ${root}: ${describeFailure(cause)}`);
        });
      }
      const lock = deps.reloadLocks.get(root);
      const detach = detachWorkspaceRoot(deps, root);
      runInScope(lock === undefined ? detach : lock.withPermits(1)(detach));
    }
    for (const added of event.added) {
      const root = fileURLToPath(added.uri);
      runInScope(
        Effect.gen(function* () {
          yield* attachWorkspaceRoot(deps, root);
          yield* watchWorkspaceConfig(deps, root, runInScope);
        }),
      );
    }
  });
};

/**
 * Build the LSP server. Returns an Effect that resolves when the client
 * sends `exit` (or `shutdownRequested` fails closed on stdio loss); the
 * ambient `Scope` then releases every workspace engine before the
 * process ends, giving the protocol a real teardown path.
 * @param connection Vscode-languageserver Connection (stdio in
 * production, in-memory for tests).
 * @returns Effect that completes on protocol exit; requires a `Scope`.
 */
export const makeLspServer = (
  connection: Connection,
): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const docs = yield* makeDocumentStore();
    const registry = yield* makeWorkspaceRegistry();
    const ready = yield* Deferred.make<void>();
    const published = yield* Ref.make<
      ReadonlyMap<string, ReadonlyMap<string, readonly Diagnostic[]>>
    >(new Map());
    const workspaceProjects = yield* Ref.make<ReadonlyMap<string, readonly string[]>>(new Map());
    const workspacePublished = yield* Ref.make<
      ReadonlyMap<string, ReadonlyMap<string, readonly Diagnostic[]>>
    >(new Map());
    const deps: ServerDeps = {
      connection,
      docs,
      registry,
      ready,
      published,
      workspaceProjects,
      workspacePublished,
      configWatchers: new Map(),
      configWatcherPaths: new Map(),
      reloadLocks: new Map(),
      reloadTimers: new Map(),
    };

    const scope = yield* Effect.scope;
    const runInScope = (effect: Effect.Effect<void, never, Scope.Scope>): void => {
      Effect.runFork(effect.pipe(Scope.extend(scope)));
    };

    // Protocol-driven teardown: `shutdown` flags intent, `exit` resolves
    // the Deferred that ends this scoped Effect (finalizers run next).
    const exited = yield* Deferred.make<number>();
    let shutdownRequested = false;
    yield* Effect.sync(() => {
      connection.onShutdown(() => {
        shutdownRequested = true;
      });
      connection.onExit(() => {
        Effect.runFork(Deferred.succeed(exited, shutdownRequested ? 0 : 1));
      });
    });

    // Capture initialize params so we can register workspaces inside
    // the Effect runtime (so engines join the ambient scope).
    let initParams: InitializeParams | null = null;
    yield* Effect.sync(() => {
      connection.onInitialize((params) => {
        initParams = params;
        return handleInitialize();
      });
    });

    setupTextHandlers(deps);

    yield* Effect.sync(() => { connection.listen(); });

    // Poll for initialize to arrive, then register workspaces under
    // the ambient Scope so engines release on server shutdown.
    // Resolve `ready` once registration completes so handlers waiting
    // on it can proceed.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let params: InitializeParams | null = initParams;
        while (params === null) {
          yield* Effect.sleep("50 millis");
          params = initParams;
        }
        if (params.capabilities.workspace?.workspaceFolders === true) {
          yield* Effect.sync(() => { setupWorkspaceFolderHandler(deps, runInScope); });
        }
        yield* registerInitialWorkspaces(deps, params, runInScope);
        yield* Deferred.succeed(ready, undefined);
      }),
    );

    return yield* Deferred.await(exited);
  }).pipe(Effect.withSpan("makeLspServer"));
