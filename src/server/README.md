# server/

The LSP delivery surface plus the shared CLI entry.

- `index.ts` — the `safer-architecture-lsp` bin: `check` (one-shot, CI),
  `serve` (stdio LSP), `--help`/`--version`.
- `lsp-server.ts` — connection wiring: workspace registration, config
  discovery + hot-reload, whole-workspace publishing with stale-URI
  clearing, protocol-driven teardown.
- `workspace-registry.ts` — one engine per workspace root, each in its
  own child Scope so teardown/reload closes watchers immediately.
- `workspace-engine.ts` — long-lived per-workspace analysis engine
  (chokidar watcher, warm ts.Program, report cache).
- `config-loader.ts` — `safer-architecture.config.json` discovery and
  validation; invalid files surface loudly, never silently.
- `diagnostic-converter.ts` / `document-store.ts` / `rule-docs.ts` —
  LSP-shape adapters around the analyzer's report.
