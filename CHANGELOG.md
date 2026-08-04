# Changelog

## 0.3.0 (2026-08-04)

- Cache external-package type walks across public entrypoints, fixing the
  Effect-heavy cold path without changing per-entrypoint findings.
- Add a global production-source coverage ratchet (68% lines/statements, 90%
  functions, 83% branches); subsequent passes will continue raising the
  ratchet toward 100%.
- Manually verify the Moltzap protocol package under a 4 GB heap stays below
  10 seconds and 1 GB RSS.
- Add deterministic file, domain, and workspace-package SCC diagnostics with
  canonical cycle paths.
- Resolve TypeScript `paths` and package `imports` aliases through one cached
  module resolver per project graph; persist a deterministic resolution
  snapshot in cached, CLI, and merged workspace reports.
- Add explicit `safer-architecture.workspace.json` support to both CLI and LSP.
  Invalid manifests block coverage; each package keeps an independent config,
  program, watcher, and cache.
- Add opt-in strict CUPID domain enforcement: inferred and explicit ownership,
  reason-carrying composition roots, boundary entrypoints, domain-cycle,
  boundary-bypass, and cross-domain side-effect rules.

## 0.2.0 (2026-07-22)

- Publish the first stable CLI/LSP contract with persistent report caching,
  sound public-type prefiltering, and deterministic exit semantics.

## 0.1.0 (2026-07-22)

First publish. Extracted from the brief repo's architecture sidecar and
reworked into a standalone tool.

- `check` CLI: one-shot whole-project analysis with a deterministic exit
  contract (0 clean / 1 findings / 2 could-not-analyze), `--json`
  machine output, and a `--waivers` suppression ledger.
- `serve`: stdio Language Server publishing diagnostics for every
  analyzed file, with protocol-driven teardown.
- Per-workspace configuration via `safer-architecture.config.json`,
  schema-validated with hot reload; invalid config is a loud failure,
  never a silent fallback.
- Suppression directives: single line
  `// safer-arch-ignore <rule-id>: <reason>` with the reason retained
  and reported. The legacy `@agent-code-guard/architecture-exception`
  marker is tombstoned (errors, never honored).
- No silent-clean states: unusable tsconfig and crashed analyses
  surface as error diagnostics.

## 0.x stability policy

Until 1.0: rule IDs, the directive grammar, the `check` exit contract,
and the `--json` top-level shape only change with a minor bump and a
CHANGELOG entry. Threshold defaults may be tuned in minors (called out
explicitly). Rule renames surface as unknown-rule parse errors rather
than silent behavior changes. The disk-cache format is versioned and
self-invalidating; its layout is not a public contract. CI users who
need bit-stable behavior should pin an exact version.

TypeScript support: the analyzer embeds `typescript` ^5.4 as its parsing
engine. Analyzed projects may use any TS version whose syntax TS 5.x
parses; a TS 7 evaluation is tracked in TODOS.
