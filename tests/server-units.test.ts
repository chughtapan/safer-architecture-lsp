/**
 * @file Unit checks for the language server pieces that hold state: the
 * open-document store, the grouping of findings into per-URI diagnostics,
 * and the workspace registry. The registry case registers one root four
 * times concurrently, since a repeat must reuse the engine, not build one.
 */

import { assert, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import path from "node:path";
import { DiagnosticSeverity } from "vscode-languageserver";
import { groupByUri } from "../src/server/diagnostic-converter.js";
import { makeDocumentStore } from "../src/server/document-store.js";
import { ruleCodeDescription } from "../src/server/rule-docs.js";
import { makeWorkspaceRegistry } from "../src/server/workspace-registry.js";
import { makeFixture } from "./support/fixtures.js";

it.effect("stores, updates, lists, and closes open documents", () =>
  Effect.gen(function* () {
    const store = yield* makeDocumentStore();
    yield* store.update("missing", 1, "ignored");
    yield* store.open({ uri: "file:///a.ts", languageId: "typescript", version: 1, text: "a" });
    yield* store.update("file:///a.ts", 2, "b");
    const updated = yield* store.get("file:///a.ts");
    const uris = yield* store.listUris();
    yield* store.close("file:///a.ts");
    const closed = yield* store.get("file:///a.ts");
    assert.deepStrictEqual(updated, {
      uri: "file:///a.ts",
      languageId: "typescript",
      version: 2,
      text: "b",
    });
    assert.deepStrictEqual(uris, ["file:///a.ts"]);
    assert.isNull(closed);
  }),
);

it("groups error and warning findings by URI with cached documentation links", () => {
  const file = path.resolve("fixture.ts");
  const groups = groupByUri([
    { ruleId: "no-module-cycle", file, severity: "warn", message: "cycle" },
    { ruleId: "no-domain-cycle", file, severity: "error", message: "domain" },
  ]);
  const diagnostics = [...groups.values()][0];
  expect(diagnostics?.map(({ severity }) => severity)).toEqual([
    DiagnosticSeverity.Warning,
    DiagnosticSeverity.Error,
  ]);
  expect(diagnostics?.[0]?.codeDescription).toBe(ruleCodeDescription("no-module-cycle"));
  expect(ruleCodeDescription("").href).toMatch(/docs\/rules\.md$/);
  expect(ruleCodeDescription("no-module-cycle")).toBe(ruleCodeDescription("no-module-cycle"));
});

it.effect("registers each workspace once and releases it on unregister", () =>
  Effect.scoped(Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() => makeFixture({ "index.ts": "export const value = 1;\n" })),
        (created) => Effect.sync(created.cleanup),
      );
      const registry = yield* makeWorkspaceRegistry();
      const registrations = yield* Effect.all(
        Array.from({ length: 4 }, () => registry.register(fixture.root)),
        { concurrency: "unbounded" },
      );
      const first = registrations[0];
      assert.isDefined(first);
      assert.isTrue(registrations.every((engine) => engine === first));
      const second = yield* registry.register(fixture.root);
      assert.strictEqual(second, first);
      assert.deepStrictEqual(yield* registry.listProjectRoots(), [fixture.root]);
      assert.strictEqual(yield* registry.findByProjectRoot(fixture.root), first);
      yield* registry.unregister("missing");
      yield* registry.unregister(fixture.root);
      assert.isNull(yield* registry.findByProjectRoot(fixture.root));
    })),
);
