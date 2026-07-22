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

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { Deferred, Effect, Ref, Scope, Stream } from "effect";
import {
  type Connection,
  type Diagnostic,
  DiagnosticSeverity,
  type InitializeParams,
  type InitializeResult,
  type PublishDiagnosticsParams,
  TextDocumentSyncKind,
} from "vscode-languageserver";
import { clearWorkspaceCache } from "../analyzer/project/cache/index.js";
import { groupByUri } from "./diagnostic-converter.js";
import { type DocumentStore, makeDocumentStore } from "./document-store.js";
import { type WorkspaceEngine } from "./workspace-engine.js";
import { type WorkspaceRegistry, makeWorkspaceRegistry } from "./workspace-registry.js";
import { CONFIG_FILE_NAME, loadWorkspaceConfig } from "./config-loader.js";

// Resolved at runtime relative to the compiled dist/server/ layout so the
// advertised server version always matches the published package version.
const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

const log = (message: string): void => {
  process.stderr.write(`[safer-architecture-lsp] ${message}\n`);
};

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
  readonly published: Ref.Ref<ReadonlyMap<string, ReadonlySet<string>>>;

  /** One config-file watcher per workspace root; survives engine reloads. */
  readonly configWatchers: Map<string, FSWatcher>;
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
      if (!filePath.startsWith(root + path.sep) && filePath !== root) continue;
      if (best === null || root.length > best.len) best = { root, len: root.length };
    }
    if (best === null) return null;
    return yield* registry.findByProjectRoot(best.root);
  });

const sendDiagnostics = (
  deps: ServerDeps,
  uri: string,
  diagnostics: readonly Diagnostic[],
): Effect.Effect<void> =>
  Effect.sync(() => {
    const params: PublishDiagnosticsParams = { uri, diagnostics: [...diagnostics] };
    deps.connection.sendDiagnostics(params);
  });

/** A file-level error diagnostic built outside the analyzer (config problems, engine crashes). */
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
      yield* Effect.sync(() => log(`analysis failed for ${root}: ${outcome.error.message}`));
    }

    const previous = (yield* Ref.get(deps.published)).get(root) ?? new Set<string>();
    for (const uri of previous) {
      if (!nextUris.has(uri)) yield* sendDiagnostics(deps, uri, []);
    }
    for (const [uri, diagnostics] of nextUris) {
      yield* sendDiagnostics(deps, uri, diagnostics);
    }
    yield* Ref.update(deps.published, (map) => {
      const next = new Map(map);
      next.set(root, new Set(nextUris.keys()));
      return next;
    });
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
 */
const attachWorkspace = (
  deps: ServerDeps,
  root: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const config = loadWorkspaceConfig(root);
    const engine = yield* deps.registry.register(root, config.options);
    yield* Effect.sync(() =>
      log(
        `workspace ${root} registered (options: ${config.source}${config.problem === null ? "" : "; config INVALID, using defaults"})`,
      ),
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

/** Tear the workspace down and clear everything it ever published. */
const detachWorkspace = (deps: ServerDeps, root: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const previous = (yield* Ref.get(deps.published)).get(root) ?? new Set<string>();
    for (const uri of previous) yield* sendDiagnostics(deps, uri, []);
    yield* Ref.update(deps.published, (map) => {
      const next = new Map(map);
      next.delete(root);
      return next;
    });
    yield* deps.registry.unregister(root);
    yield* Effect.sync(() => log(`workspace ${root} detached`));
  });

/** Rebuild the workspace's engine after a config change. */
const reloadWorkspace = (
  deps: ServerDeps,
  root: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => log(`config change detected for ${root}; reloading`));
    yield* deps.registry.unregister(root);
    yield* attachWorkspace(deps, root);
  });

/**
 * Watch the workspace's config file so edits take effect without a
 * server restart. The watcher lives outside the engine's child scope
 * (it triggers engine replacement) and is closed on detach/shutdown.
 */
const watchWorkspaceConfig = (
  deps: ServerDeps,
  root: string,
  runInScope: (effect: Effect.Effect<void, never, Scope.Scope>) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const configPath = path.join(root, CONFIG_FILE_NAME);
      const watcher = chokidarWatch(configPath, { ignoreInitial: true, persistent: true });
      const onEvent = (): void => runInScope(reloadWorkspace(deps, root));
      watcher.on("add", onEvent);
      watcher.on("change", onEvent);
      watcher.on("unlink", onEvent);
      deps.configWatchers.set(root, watcher);
      return watcher;
    }),
    (watcher) =>
      Effect.promise(async () => {
        await watcher.close();
      }),
  ).pipe(Effect.asVoid);

const workspaceRootsFrom = (params: InitializeParams): readonly string[] => {
  const folders = params.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders.map((folder) => fileURLToPath(folder.uri));
  }
  // Plenty of clients still send only rootUri/rootPath; total silence
  // for them would be indistinguishable from a clean workspace.
  if (params.rootUri) return [fileURLToPath(params.rootUri)];
  if (params.rootPath) return [path.resolve(params.rootPath)];
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
        log("no workspace folders, rootUri, or rootPath in initialize; nothing to analyze"),
      );
    }
    for (const root of roots) {
      yield* attachWorkspace(deps, root);
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
    if (engine === null) return;
    yield* publishWorkspace(deps, engine);
  });

const handleDidSave = (
  deps: ServerDeps,
  uri: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Deferred.await(deps.ready);
    const engine = yield* findEngineForUri(deps.registry, uri);
    if (engine === null) return;
    // Force-invalidate so the next lint sees the saved content, even
    // if the watcher is slower than our handler.
    yield* Effect.sync(() => clearWorkspaceCache(engine.projectRoot));
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
    if (last === undefined || !("text" in last)) return;
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
      if (watcher) void watcher.close();
      Effect.runFork(detachWorkspace(deps, root));
    }
    for (const added of event.added) {
      const root = fileURLToPath(added.uri);
      runInScope(
        Effect.gen(function* () {
          yield* attachWorkspace(deps, root);
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
 * @param connection vscode-languageserver Connection (stdio in
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
    const published = yield* Ref.make<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
    const deps: ServerDeps = {
      connection,
      docs,
      registry,
      ready,
      published,
      configWatchers: new Map(),
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

    yield* Effect.sync(() => connection.listen());

    // Poll for initialize to arrive, then register workspaces under
    // the ambient Scope so engines release on server shutdown.
    // Resolve `ready` once registration completes so handlers waiting
    // on it can proceed.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (initParams === null) {
          yield* Effect.sleep("50 millis");
        }
        const params: InitializeParams = initParams;
        if (params.capabilities.workspace?.workspaceFolders === true) {
          yield* Effect.sync(() => setupWorkspaceFolderHandler(deps, runInScope));
        }
        yield* registerInitialWorkspaces(deps, params, runInScope);
        yield* Deferred.succeed(ready, undefined);
      }),
    );

    return yield* Deferred.await(exited);
  }).pipe(Effect.withSpan("makeLspServer"));
