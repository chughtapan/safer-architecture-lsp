# LSP server

`safer-architecture-lsp` is a long-lived Language Server Protocol
implementation that publishes whole-project architecture diagnostics
directly to your editor. No per-process lint cold-start; the analyzer's
report stays warm across edits.

## Install

```bash
npm install --save-dev @chughtapan/safer-architecture-lsp
```

Point any stdio LSP client at the `safer-architecture-lsp` bin for
`.ts`/`.tsx` files. Hosts that cannot multiplex two servers for one file
extension can front it with an LSP proxy alongside
`typescript-language-server`.

## Capabilities

| Capability | Behavior |
|---|---|
| `textDocumentSync.openClose` | true |
| `textDocumentSync.change` | `Incremental` (V1: stored, not re-analyzed) |
| `textDocumentSync.save` | `includeText: false` (server reads from disk) |
| `workspace.workspaceFolders.supported` | true |
| `workspace.workspaceFolders.changeNotifications` | true |

## Diagnostic lifecycle

| Event | What the server does |
|---|---|
| `initialize` | Registers each `workspaceFolders[i]` as a `WorkspaceEngine`. Each engine spins up a `chokidar` watcher scoped to `package.json`, `tsconfig*.json`, and `.ts` / `.tsx` / `.mts` / `.cts` files under the folder. |
| `textDocument/didOpen` | Stores the document. Runs the architecture analyzer for the workspace. Publishes diagnostics for the opened URI. |
| `textDocument/didChange` | Updates the in-memory document store. **Does not re-analyze** — V1 is save-time only. |
| `textDocument/didSave` | Force-invalidates the workspace cache (`clearWorkspaceCache`). Re-runs the analyzer. Publishes diagnostics for every open document in the workspace. |
| `textDocument/didClose` | Drops the document. Publishes empty diagnostics (clears editor squigglies). |
| Watcher fires (out-of-band edit) | Invalidates the cache. Publishes diagnostics for every open document in the affected workspace. |

## Diagnostic shape

Architecture diagnostics are project-level findings (e.g., "this folder
participates in a cycle"). The LSP server emits them as `Diagnostic` records
pinned to the start of each participating file. Editors group findings by the
`code` field (the rule ID).

```jsonc
{
  "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
  "severity": 1,                              // 1 = Error, 2 = Warning
  "code": "no-folder-cycle",
  "source": "agent-code-guard",
  "message": "Folder src/services is in a cycle with src/models, src/db"
}
```

Severity maps from the analyzer's `error` / `warn` to LSP's `Error` / `Warning`.

## Performance

| Operation | Typical wall time |
|---|---|
| Cold open of a workspace | 3–5 s (analyzer first build, ~1500-file project) |
| Subsequent `didOpen` after cold | < 100 ms (disk cache hit) |
| `didSave` round-trip (lint + publish) | 200–500 ms (cache fresh, only requested files filtered) |
| Watcher → republish | 100–300 ms after the chokidar event |

The disk cache at `<workspace>/node_modules/.cache/agent-code-guard/report.json`
is shared with `eslint-plugin-agent-code-guard`. If you already ran ESLint
once, the LSP boot is warm. The watermark covers source files, `package.json`,
`tsconfig.json`, and analyzer version — edits to any of them invalidate.

## What V1 does not do

- **Live overlay diagnostics on `didChange`.** Editing without saving doesn't
  re-publish. The analyzer reads from disk; a `LanguageService`-host overlay
  (so unsaved buffer contents flow into the analyzer) is a follow-up. The
  `programFingerprint` plumbing in `WorkspaceCache` is ready for it.
- **Multi-root workspaces with overlapping package roots.** Each workspace
  folder gets its own engine keyed on its URI; nested folders that share a
  `package.json` ancestor outside the registered roots aren't handled
  specially. Real-world cases are rare; a `findNearestPackageRoot` walk on
  every `didOpen` is the fix when this comes up.
- **Workspace-folder removal.** `workspace/didChangeWorkspaceFolders` for
  removed folders doesn't release that folder's engine — engines live for the
  LSP process lifetime in V1.

## Lifecycle

The server runs inside `Effect.scoped(makeLspServer(connection))`. The
protocol `shutdown`/`exit` sequence (or stdio loss) completes the scoped
Effect and the ambient `Scope`'s finalizers fire: every workspace
engine's `chokidar` watcher closes, every `WorkspaceCache` clears. Each
engine additionally lives in its own child scope, so a config reload or
workspace-folder removal tears down exactly one engine.

## Configuration

Each workspace reads `safer-architecture.config.json` at its root
(schema-validated through `resolveArchitectureOptions`). Invalid config
surfaces as an error diagnostic on the config file and defaults apply;
edits to the file hot-reload the workspace's engine. The `check` CLI
reads the same file, so editor and CI verdicts agree by construction.
