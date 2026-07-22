/**
 * @file In-memory store of currently-open LSP documents. Tracks URI,
 * version, text, and the workspace folder each document belongs to.
 * Pure data plus Effect-wrapped accessors so the LSP handlers don't
 * leak imperative state outside this module.
 */

import { Effect, Ref } from "effect";

interface OpenDocument {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  readonly languageId: string;
}

export interface DocumentStore {
  readonly open: (doc: OpenDocument) => Effect.Effect<void>;
  readonly update: (
    uri: string,
    version: number,
    text: string,
  ) => Effect.Effect<void>;
  readonly close: (uri: string) => Effect.Effect<void>;
  readonly get: (uri: string) => Effect.Effect<OpenDocument | null>;
  readonly listUris: () => Effect.Effect<readonly string[]>;
}

/**
 * Build a fresh document store backed by an Effect `Ref`. Each
 * accessor returns an Effect so the store is composable inside the
 * LSP handler pipelines without leaking the underlying Map.
 * @returns Effect producing a `DocumentStore`.
 */
export const makeDocumentStore = (): Effect.Effect<DocumentStore> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, OpenDocument>>(new Map());

    const open = (doc: OpenDocument): Effect.Effect<void> =>
      Ref.update(ref, (map) => {
        const next = new Map(map);
        next.set(doc.uri, doc);
        return next;
      });

    const update = (
      uri: string,
      version: number,
      text: string,
    ): Effect.Effect<void> =>
      Ref.update(ref, (map) => {
        const existing = map.get(uri);
        if (existing === undefined) return map;
        const next = new Map(map);
        next.set(uri, { ...existing, version, text });
        return next;
      });

    const close = (uri: string): Effect.Effect<void> =>
      Ref.update(ref, (map) => {
        const next = new Map(map);
        next.delete(uri);
        return next;
      });

    const get = (uri: string): Effect.Effect<OpenDocument | null> =>
      Ref.get(ref).pipe(Effect.map((map) => map.get(uri) ?? null));

    const listUris = (): Effect.Effect<readonly string[]> =>
      Ref.get(ref).pipe(Effect.map((map) => [...map.keys()]));

    return { open, update, close, get, listUris };
  });
