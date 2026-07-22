# Architecture Project Model

This folder owns the shared project model used by architecture diagnostics.

- `api/` is the public implementation facade for architecture config,
  diagnostics, source files, package metadata, and source paths.
- `source-model/` owns graph data structures and module classification.
- `config.ts` and `config-schema.ts` parse and validate rule options.
- `cache/` owns workspace-scoped in-memory reports plus the persistent
  disk cache shared across analyzer runs.
- `diagnostics/` owns diagnostic types and de-duplication.
- `package-exports/`, `package-json.ts`, `source-files.ts`, and
  `source-paths.ts` provide focused project facts.

Diagnostics should depend on this model rather than re-reading files or
re-deriving source classification locally.
