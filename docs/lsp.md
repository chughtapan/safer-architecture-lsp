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
| `textDocumentSync.change` | `Full` (stored, not re-analyzed until save) |
| `textDocumentSync.save` | `includeText: false` (server reads from disk) |
| `workspace.workspaceFolders.supported` | true |
| `workspace.workspaceFolders.changeNotifications` | true |

## Diagnostic lifecycle

| Event | What the server does |
|---|---|
| `initialize` | Discovers each client workspace folder. If `safer-architecture.workspace.json` exists, registers one scoped engine per explicitly listed package; otherwise registers the folder as one project. Publishes an initial whole-project report. |
| `textDocument/didOpen` | Stores the document and republishes the containing project's complete report. |
| `textDocument/didChange` | Replaces the stored full document text. **Does not re-analyze** — analysis remains save-time. |
| `textDocument/didSave` | Force-invalidates the containing project's cache, re-runs analysis, and republishes its complete report. |
| `textDocument/didClose` | Drops the in-memory buffer. Project diagnostics remain published because findings do not depend on whether a file is open. |
| Source watcher fires (out-of-band edit) | Invalidates and republishes the affected project's complete report. |
| Workspace/config/package metadata changes | Debounces and serializes a workspace reload, then republishes project and package-cycle diagnostics together. |
| Workspace folder added/removed | Attaches or releases that folder's projects, watchers, caches, and published diagnostics. |

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
  "source": "safer-architecture",
  "message": "Folder src/services is in a cycle with src/models, src/db"
}
```

Severity maps from the analyzer's `error` / `warn` to LSP's `Error` / `Warning`.

## Performance

Each project keeps its last `ts.Program` warm for incremental rebuilds and
shares the deterministic disk report with the `check` CLI at
`<project>/node_modules/.cache/safer-architecture-lsp/report.json`. Its
watermark covers source files, `package.json`, TypeScript configuration, and
the analyzer/cache version; a separate hash covers every resolved option.
Workspace packages retain independent programs and caches, so a change in one
package does not require combining every package into one TypeScript program.

## What V1 does not do

- **Live overlay diagnostics on `didChange`.** Editing without saving doesn't
  re-publish. The analyzer reads from disk; a `LanguageService`-host overlay
  (so unsaved buffer contents flow into the analyzer) is a follow-up. The
  `programFingerprint` plumbing in `WorkspaceCache` is ready for it.
- **Implicit monorepo discovery or globbed package lists.** Package roots must
  be listed literally in `safer-architecture.workspace.json`; every package is
  analyzed using its own TypeScript project.
- **Cross-package source and project-reference edges.** Workspace topology is
  derived from declared runtime and peer dependencies, while source imports
  remain scoped to each package's TypeScript program.

## Lifecycle

The server runs inside `Effect.scoped(makeLspServer(connection))`. The
protocol `shutdown`/`exit` sequence completes the scoped Effect and the ambient
`Scope`'s finalizers fire: every metadata/source watcher closes and every
workspace cache clears. Each project engine lives in its own child scope, so a
config reload or workspace-folder removal tears down exactly that engine.

## Configuration

Each project reads `safer-architecture.config.json` at its root
(schema-validated through `resolveArchitectureOptions`). Invalid project config
surfaces as an error diagnostic on the config file while defaults keep editor
analysis available; `check` instead exits `2` so CI never silently accepts
defaults. An invalid `safer-architecture.workspace.json` blocks every listed
project and surfaces `invalid-workspace-config`. Edits to either file, or to a
listed package's `package.json`, hot-reload the workspace.
