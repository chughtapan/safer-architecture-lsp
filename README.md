# safer-architecture-lsp

Whole-project TypeScript architecture analysis with a deterministic CI
gate and live editor diagnostics. It builds a real `ts.Program`, derives
the folder-level import graph, and reports structural findings — cycles,
layering violations, oversized public surfaces, boundary leaks — with
every suppression carrying a written, auditable reason.

**Why this instead of an ESLint rule?** Whole-project analysis doesn't
fit a per-file lint model, and per-keystroke re-analysis doesn't fit CI
tools. This package runs one warm analysis core behind two surfaces: a
`check` command whose exit code CI can trust, and a Language Server that
streams the same findings into the diagnostics channel your editor — or
your coding agent — already reads. An agent that introduces a cycle sees
the diagnostic while authoring, and the escape hatch is one line it must
justify: that inline feedback loop, with a queryable waiver ledger, is
the wedge.

> **Status: 0.1.0.** Rule heuristics are young and tuned on small
> single-package repos; expect to configure. See the 0.x stability
> policy in [CHANGELOG.md](./CHANGELOG.md).

## CI in two minutes

```bash
npm install --save-dev @chughtapan/safer-architecture-lsp
npx safer-architecture-lsp check .
```

`check` analyzes the project once and exits `0` (clean), `1` (findings),
or `2` (could not analyze — bad root, invalid config, unusable
tsconfig). It always prints a summary line, so an empty result is
distinguishable from a run that never happened:

```
safer-architecture check: 0 finding(s) across 0 file(s), 4 waiver(s), options from file — /repo
```

`--json` emits the full report (diagnostics + waivers) for machine
consumption; `--waivers` prints the suppression ledger with reasons.

`check` writes a persistent report to
`node_modules/.cache/safer-architecture-lsp/`, keyed by a content
watermark over the project's sources, `package.json`, and `tsconfig`. A
repeat run on an unchanged project reuses it instead of rebuilding the
`ts.Program`, so **cache that directory in CI** to amortize cold cost. In
a monorepo, run one `check` per package through a build tool's cache and
parallelism (nx/turbo) rather than a sequential shell loop — each
invocation is a whole-project analysis.

## Editor / agent setup

The `serve` subcommand speaks LSP over stdio:

```jsonc
// Claude Code plugin.json
{
  "lspServers": {
    "safer-architecture": {
      "command": "safer-architecture-lsp",
      "args": ["serve"],
      "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact" }
    }
  }
}
```

Any stdio LSP client works the same way (`command: safer-architecture-lsp`,
`args: ["serve"]`). Diagnostics are published for **every** analyzed
file, not just open ones, and each finding deep-links its rule
reference. Hosts that cannot run two servers for one file extension can
front this server with the bundled `safer-lsp-proxy` multiplexer
alongside `typescript-language-server`: the first backend in its config
is primary, and a sidecar crash never takes the primary down.

Verify it's alive: stderr logs one line per workspace registration and
per publish (`published N finding(s) across M file(s) … in Xms`).

## Configuration

Put `safer-architecture.config.json` at the workspace root. It is
schema-validated; an invalid file fails `check` runs loudly and surfaces
as an error diagnostic in the editor (with defaults applied). Edits
hot-reload the workspace. The knobs you'll actually touch first:

```jsonc
{
  // Third-party types intentionally part of your public API:
  "publicTypePackages": [
    { "package": "typescript", "reason": "our contract is ts.Program-shaped" }
  ],
  // Folders siblings may import freely (your shared kernel):
  "sharedFolderNames": [
    { "folder": "analyzer", "reason": "one analysis core, many surfaces" }
  ],
  // Deliberate non-index facade files:
  "facadeFiles": [
    { "file": "server/workspace-engine.ts", "reason": "engine contract" }
  ],
  // Public-surface budgets (defaults shown):
  "maxPublicExports": 20,
  "maxSubpathExports": 5
}
```

Every allowance entry requires a `reason` — writing it *is* the
architectural decision. The full option list lives in
[docs/rules.md](./docs/rules.md), mapped rule-by-rule to the options
that control it. This repository's own
[safer-architecture.config.json](./safer-architecture.config.json) is a
working example: CI runs `check .` on this codebase and fails on any
unwaived finding.

## Rules

The complete reference — what each rule flags, why, its controlling
options, and how to fix it — is [docs/rules.md](./docs/rules.md).
Categories: import topology (cycles, layering, sibling domains), public
surface (curation, size budgets, vendor-type leaks), folder shape
(size, READMEs, explicit APIs), and module shape (accidental
boundaries, trivial indirection, fat orchestrators).

## Suppressions (waivers)

One comment line, file-scoped, reason mandatory:

```ts
// safer-arch-ignore no-trivial-sink-file: deliberate seam; the overlay follow-up grows here.
```

A missing or empty reason is itself a diagnostic. Granted waivers are
retained with their reasons and queryable via `check --waivers` — an
auditable ledger, not a muted warning. Unknown rule ids error. The
legacy two-line `@agent-code-guard/architecture-exception` marker from
this code's previous life is never honored and always errors, so a
stale suppression cannot silently stop working.

## Programmatic API

```ts
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "@chughtapan/safer-architecture-lsp";

const options = resolveArchitectureOptions({ projectRoot: process.cwd() });
const report = analyzeResolvedArchitecture(options);
for (const d of report.diagnostics) console.log(d.ruleId, d.file, d.message);
for (const w of report.waivers) console.log("waived", w.ruleId, w.reason);
```

## Scope and limits (read before adopting)

- The import graph resolves **relative imports** within one package.
  `tsconfig` path aliases, workspace packages, and project references
  are not yet modeled (tracked in TODOS) — in a monorepo, run one
  `check` per package root.
- Analysis is save-time in the editor; live keystroke-level diagnostics
  are a follow-up.
- A tsconfig found above the workspace root is scoped to the
  workspace's files automatically.

## Troubleshooting

- **No diagnostics at all?** Check stderr. A missing/broken tsconfig now
  surfaces as an `architecture-analysis-unavailable` error diagnostic —
  if you see literally nothing, your client isn't connected (`serve`
  missing from args is the common cause; a bare invocation prints help
  and exits instead of hanging).
- **"config INVALID" in stderr / squiggle on the config file** — the
  JSON failed schema validation; the message names the offending key.
- **Findings vanished after an edit?** The engine hot-reloaded with your
  new config; run `check --waivers` to see what is being suppressed.

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # vitest: analyzer fixtures, CLI contract, proxy, full LSP session
npm run lint    # knip
node dist/server/index.js check .   # the dogfood gate CI enforces
```

Publishing: push a `vX.Y.Z` tag matching `package.json` — the publish
workflow builds, tests, lints, self-checks, then publishes to npm via
trusted publishing.
