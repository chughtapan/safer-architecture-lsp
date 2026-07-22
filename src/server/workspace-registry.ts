/**
 * @file Per-LSP-process registry of `WorkspaceEngine` instances. The
 * LSP server registers one engine per workspace folder; this module
 * memoizes engines on `projectRoot` so reopening a folder reuses the
 * existing engine + cache.
 *
 * V1 design: engines live for the registry's `Scope` lifetime (i.e.,
 * the LSP process). Per-workspace teardown via `unregister` is a
 * follow-up — the LSP doesn't yet send `workspace/didChangeWorkspaceFolders`
 * for removals in a way that warrants the scope-fork complexity.
 */

import { Effect, Ref, Scope } from "effect";
import { resolveArchitectureOptions, type ArchitectureOptionsInput } from "../analyzer/project/api/index.js";
import { type WorkspaceEngine, makeWorkspaceEngine } from "./workspace-engine.js";

type EngineMap = ReadonlyMap<string, WorkspaceEngine>;

function lookupEngine(map: EngineMap, projectRoot: string): WorkspaceEngine | undefined {
  return map.get(projectRoot);
}

function insertEngine(
  map: EngineMap,
  projectRoot: string,
  engine: WorkspaceEngine,
): EngineMap {
  const next = new Map(map);
  next.set(projectRoot, engine);
  return next;
}

function makeInserter(
  projectRoot: string,
  engine: WorkspaceEngine,
): (map: EngineMap) => EngineMap {
  return (map) => insertEngine(map, projectRoot, engine);
}

function makeLookup(projectRoot: string): (map: EngineMap) => WorkspaceEngine | null {
  return (map) => lookupOrNull(map, projectRoot);
}

function lookupOrNull(map: EngineMap, projectRoot: string): WorkspaceEngine | null {
  return map.get(projectRoot) ?? null;
}

function listKeys(map: EngineMap): readonly string[] {
  return [...map.keys()];
}

export interface WorkspaceRegistry {
  readonly register: (
    projectRoot: string,
    options?: ArchitectureOptionsInput,
  ) => Effect.Effect<WorkspaceEngine, never, Scope.Scope>;

  readonly findByProjectRoot: (
    projectRoot: string,
  ) => Effect.Effect<WorkspaceEngine | null>;

  readonly listProjectRoots: () => Effect.Effect<readonly string[]>;
}

/**
 * Build a registry whose engines share the ambient `Scope`. All
 * registered engines release when that scope closes — which for the
 * LSP server is process exit.
 * @returns Effect producing the registry.
 */
export const makeWorkspaceRegistry = (): Effect.Effect<WorkspaceRegistry> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, WorkspaceEngine>>(new Map());

    const register = (
      projectRoot: string,
      options?: ArchitectureOptionsInput,
    ): Effect.Effect<WorkspaceEngine, never, Scope.Scope> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(ref);
        const existing = lookupEngine(map, projectRoot);
        if (existing !== undefined) return existing;
        const resolved = resolveArchitectureOptions({
          ...(options ?? {}),
          projectRoot,
        });
        const engine = yield* makeWorkspaceEngine(resolved);
        yield* Ref.update(ref, makeInserter(projectRoot, engine));
        return engine;
      });

    const findByProjectRoot = (
      projectRoot: string,
    ): Effect.Effect<WorkspaceEngine | null> =>
      Effect.map(Ref.get(ref), makeLookup(projectRoot));

    const listProjectRoots = (): Effect.Effect<readonly string[]> =>
      Effect.map(Ref.get(ref), listKeys);

    return { register, findByProjectRoot, listProjectRoots };
  });
