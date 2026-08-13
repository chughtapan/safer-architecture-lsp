# Changelog

## 0.3.1 (2026-08-12)

- Adopt Agent Code Guard 0.0.21's `recommended` ESLint policy as a blocking
  quality gate. `npm run lint` now runs ESLint and Knip, and CI enforces it.
- Add a type-aware flat config that lints src, tests, and root config files.
  `tsconfig.test.json` brings tests into a program for the first time, which
  surfaced and fixed five type errors in tests/graph.test.ts that were
  invisible while tests sat outside every tsconfig.
- Document every exported declaration and add a canonical `@file` overview to
  each linted module.
- Replace JavaScript private fields with the TypeScript `private` modifier,
  give every `.sort()` an explicit comparator that reproduces lexicographic
  order without locale dependence, and order declarations callers-first.
- Migrate the server and proxy binaries to `Effect.Effect<undefined>` and
  convert their remaining raw promise surfaces to Effect, including a typed
  `BackendWriteError`. No public API changed: the package exports a single
  entry that re-exports only the analyzer.
- Add property cases where tests previously asserted a single example: 77
  named tests to 87, none removed. Coverage rises to 78.27% lines.
- Upload the coverage report as a CI artifact when a run fails, so a gate
  failure is diagnosable rather than lost.

## 0.3.0 (2026-08-12)

- Cache external-package type walks across public entrypoints, fixing the
  Effect-heavy cold path without changing per-entrypoint findings.
- Measure coverage with c8 so the server, proxy, and CLI suites that exercise
  the built `dist/` bins through spawned processes are counted; an in-process
  v8 provider reported those files as 0%. Server coverage is now visible
  (`lsp-server.ts` 82.5%, `server/index.ts` 93.5%, `workspace-report.ts`
  98.1%, `package-cycles.ts` 100%).
- Add a global production-source coverage ratchet (74% lines/statements, 72%
  branches) in `.c8rc.json` plus per-directory floors in
  `scripts/coverage-gate.mjs`, both enforced by CI; subsequent passes will
  continue raising them toward 100%. The thresholds measure the whole shipped
  surface, so they are not comparable to a provider that sees only in-process
  code. Function coverage is reported but not gated: c8 undercounts function
  ranges through the dist sourcemaps.
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
