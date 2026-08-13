/**
 * @file In-memory store of currently-open LSP documents. Tracks URI,
 * version, text, and the workspace folder each document belongs to.
 * Pure data plus Effect-wrapped accessors so the LSP handlers don't
 * leak imperative state outside this module.
 */

import { Effect, Ref } from "effect";


// safer-arch-ignore no-trivial-sink-file: the buffer store stays separate so the overlay-diagnostics follow-up can grow here without touching lsp-server.
interface OpenDocument {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  readonly languageId: string;
}

/**
 * Effect-returning handle over the open-document set. `get` reports an
 * unknown URI as `null`, and `update` on an unknown URI is a no-op, so a
 * change notification racing a close cannot revive a closed buffer.
 * Mutating accessors succeed with `undefined` rather than `void`, which
 * is not a legal Effect success type.
 */
export interface DocumentStore {
  readonly open: (doc: OpenDocument) => Effect.Effect<undefined>;
  readonly update: (
    uri: string,
    version: number,
    text: string,
  ) => Effect.Effect<undefined>;
  readonly close: (uri: string) => Effect.Effect<undefined>;
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

    const open = (doc: OpenDocument): Effect.Effect<undefined> =>
      Ref.update(ref, (map) => {
        const next = new Map(map);
        next.set(doc.uri, doc);
        return next;
      }).pipe(Effect.as(undefined));

    const update = (
      uri: string,
      version: number,
      text: string,
    ): Effect.Effect<undefined> =>
      Ref.update(ref, (map) => {
        const existing = map.get(uri);
        if (existing === undefined) {return map;}
        const next = new Map(map);
        next.set(uri, { ...existing, version, text });
        return next;
      }).pipe(Effect.as(undefined));

    const close = (uri: string): Effect.Effect<undefined> =>
      Ref.update(ref, (map) => {
        const next = new Map(map);
        next.delete(uri);
        return next;
      }).pipe(Effect.as(undefined));

    const get = (uri: string): Effect.Effect<OpenDocument | null> =>
      Ref.get(ref).pipe(Effect.map((map) => map.get(uri) ?? null));

    const listUris = (): Effect.Effect<readonly string[]> =>
      Ref.get(ref).pipe(Effect.map((map) => [...map.keys()]));

    return { open, update, close, get, listUris };
  }).pipe(Effect.withSpan("makeDocumentStore"));
