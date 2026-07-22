# module-shape

Rules that score the *shape* of an individual module — how many things it
exports, who imports it, and whether its surface coheres.

| File | Rule | What it flags |
|------|------|---------------|
| `implicit-boundary.ts` | `file-implicit-boundary-module` | Non-facade files that act as implicit boundaries between caller and implementation regions. |
| `shared-kernel-cohesion.ts` | `shared-kernel-cohesion` | Wide shared-kernel files whose exports are consumed by mostly disjoint modules. |
| `no-trivial-sink-file.ts` | `no-trivial-sink-file` | Tiny files (≤2 exports, ≤5 statements) with exactly one consumer that uses (not re-exports) the symbols. Inline at the call site. |
| `no-fat-orchestrator.ts` | `no-fat-orchestrator` | Non-entry files with high fan-out (≥15), low fan-in (≤1), and a substantive body (≥20 top-level statements). Either declare it an entry point or split. |

## Boundary

These rules read the project graph (`graph.modules`,
`graph.exportConsumersByFileName`, `module.localEdges`,
`module.externalEdges`, `module.topLevelStatementCount`,
`module.exportedSymbolCount`) and emit `ArchitectureDiagnostic`s. They never
walk file ASTs directly; the graph builder is the single source of truth for
counting.

The `index.ts` here composes these checks into `checkModuleShape`, which is
called once per project from the architecture analyzer entry point.
