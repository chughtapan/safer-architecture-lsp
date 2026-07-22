# Import Graph

This folder owns local import resolution and graph analysis for architecture
diagnostics.

- `project-graph/` builds the project graph facade from TypeScript source.
- `specifier-resolution.ts` resolves local module specifiers.
- `edges.ts`, `folder-edges.ts`, and `folder-graph.ts` derive module and folder
  dependency graphs.
- `folder-distance.ts` measures import reach across folder paths.
- `module-symbols.ts` extracts exported symbol relationships from source files.

Code outside this folder should prefer `index.ts` or the higher-level
architecture/project facades instead of importing graph internals directly.
