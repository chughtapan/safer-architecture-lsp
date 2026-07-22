/**
 * @file Per-LSP-process registry of `WorkspaceEngine` instances. Each
 * engine is acquired in its own child `Scope` forked from the ambient
 * one, so a single workspace can be torn down (config reload, folder
 * removal) without touching its siblings: closing the child scope runs
 * the engine's finalizers (chokidar watcher, cache clear) immediately
 * instead of at process exit.
 */

import { Effect, Exit, ExecutionStrategy, Ref, Scope } from "effect";
import { resolveArchitectureOptions, type ArchitectureOptionsInput } from "../analyzer/project/api/index.js";
import { type WorkspaceEngine, makeWorkspaceEngine } from "./workspace-engine.js";

interface EngineEntry {
  readonly engine: WorkspaceEngine;
  readonly scope: Scope.CloseableScope;
}

type EngineMap = ReadonlyMap<string, EngineEntry>;

function insertEntry(
  map: EngineMap,
  projectRoot: string,
  entry: EngineEntry,
): EngineMap {
  const next = new Map(map);
  next.set(projectRoot, entry);
  return next;
}

function removeEntry(map: EngineMap, projectRoot: string): EngineMap {
  const next = new Map(map);
  next.delete(projectRoot);
  return next;
}

export interface WorkspaceRegistry {
  readonly register: (
    projectRoot: string,
    options?: ArchitectureOptionsInput,
  ) => Effect.Effect<WorkspaceEngine, never, Scope.Scope>;

  /**
   * Tear down one workspace: closes its child scope (watcher + cache
   * finalizers run now) and forgets the engine. No-op for unknown roots.
   */
  readonly unregister: (projectRoot: string) => Effect.Effect<void>;

  readonly findByProjectRoot: (
    projectRoot: string,
  ) => Effect.Effect<WorkspaceEngine | null>;

  readonly listProjectRoots: () => Effect.Effect<readonly string[]>;
}

/**
 * Build a registry whose engines each live in a child of the ambient
 * `Scope`. Closing the ambient scope (process shutdown) still releases
 * every engine; `unregister` releases exactly one.
 * @returns Effect producing the registry.
 */
export const makeWorkspaceRegistry = (): Effect.Effect<WorkspaceRegistry> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<EngineMap>(new Map());

    const register = (
      projectRoot: string,
      options?: ArchitectureOptionsInput,
    ): Effect.Effect<WorkspaceEngine, never, Scope.Scope> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(ref);
        const existing = map.get(projectRoot);
        if (existing !== undefined) return existing.engine;
        const parent = yield* Effect.scope;
        const child = yield* Scope.fork(parent, ExecutionStrategy.sequential);
        const resolved = resolveArchitectureOptions({
          ...(options ?? {}),
          projectRoot,
        });
        const engine = yield* makeWorkspaceEngine(resolved).pipe(
          Scope.extend(child),
        );
        yield* Ref.update(ref, (m) => insertEntry(m, projectRoot, { engine, scope: child }));
        return engine;
      });

    const unregister = (projectRoot: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(ref);
        const entry = map.get(projectRoot);
        if (entry === undefined) return;
        yield* Ref.update(ref, (m) => removeEntry(m, projectRoot));
        yield* Scope.close(entry.scope, Exit.void);
      });

    const findByProjectRoot = (
      projectRoot: string,
    ): Effect.Effect<WorkspaceEngine | null> =>
      Effect.map(Ref.get(ref), (map) => map.get(projectRoot)?.engine ?? null);

    const listProjectRoots = (): Effect.Effect<readonly string[]> =>
      Effect.map(Ref.get(ref), (map) => [...map.keys()]);

    return { register, unregister, findByProjectRoot, listProjectRoots };
  });
