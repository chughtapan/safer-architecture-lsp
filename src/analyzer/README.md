# Architecture Rules

This folder owns graph-backed architecture diagnostics. These rules analyze
the whole TypeScript project, not only the currently linted file.

The implementation is organized by analysis surface:

- `exports/` inspects index and public export curation.
- `folder-shape/` inspects folder size, README, and facade pressure.
- `imports/` builds and analyzes local import topology.
- `module-shape/` inspects accidental boundary modules and shared kernels.
- `package-api/` inspects `package.json` public entries.
- `project/` builds the source model, config, cache, and diagnostic contracts.
- `type-surface/` inspects public API type ownership.

`index.ts` composes the analysis passes for the workspace-scoped cache used by
the LSP server; the package barrel (`src/index.ts`) re-exports it for
programmatic consumers.

## Performance

The LSP resolves options once and reads through a `WorkspaceCache` owned by
that project root. Its TTL defaults to 5 seconds so editor hosts see fixes
promptly while repeated diagnostic publishes reuse the report.

Valid range: `0` (always rebuild) through `Infinity`.
