# safer-architecture-lsp

Whole-project TypeScript architecture analyzer and Language Server.
It builds a folder-level import graph over a `ts.Program` and reports
architecture findings — cycles, layering violations, oversized public
surfaces, accidental boundary modules — as editor diagnostics or as a
programmatic report for CI.

Every rule links to its rationale in
[safer-by-default PRINCIPLES.md](https://github.com/chughtapan/safer-by-default/blob/main/PRINCIPLES.md),
and every architectural exception must carry a written reason, either in
config allowances or as an in-source directive.

## Install

```bash
npm install --save-dev @chughtapan/safer-architecture-lsp
```

## LSP server

The `safer-architecture-lsp` bin speaks LSP over stdio. Point any LSP
client at it for `.ts`/`.tsx` files:

```jsonc
// Claude Code plugin.json
{
  "lspServers": {
    "safer-architecture": {
      "command": "safer-architecture-lsp",
      "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact" }
    }
  }
}
```

The server registers one analysis engine per workspace folder, keeps the
report warm across edits (chokidar watcher + disk cache), and publishes
file-level diagnostics whose `codeDescription` links to the rule's
PRINCIPLES.md anchor. Analysis runs at save time; `didSave` invalidates
the cache and republishes.

Editors that cannot multiplex two servers for one file extension can
front this server with an LSP proxy alongside
`typescript-language-server` (see
[chughtapan/brief](https://github.com/chughtapan/brief) `lsp/proxy` for a
working reference).

## Programmatic API

```ts
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "@chughtapan/safer-architecture-lsp";

const options = resolveArchitectureOptions({ projectRoot: process.cwd() });
const report = analyzeResolvedArchitecture(options);
for (const d of report.diagnostics) {
  console.log(`${d.severity} ${d.ruleId} ${d.file}: ${d.message}`);
}
```

`resolveArchitectureOptions` validates against an
[Effect Schema](https://effect.website) with per-issue error messages.
Allowance lists (`allowedPublicSubpaths`, shared-kernel folders, public
contract types, …) require a `reason` string per entry — writing the
reason *is* the architectural decision.

## Rules

The registry in `src/analyzer/rule-ids.ts` is the single source of
truth. Highlights:

| Rule | Guards against |
| --- | --- |
| `no-folder-cycle`, `no-root-internal-cycle` | dependency cycles between folders / root modules |
| `no-upward-layer-import`, `no-cross-domain-sibling-import`, `no-distant-folder-import` | layering and domain-boundary violations |
| `no-large-public-surface`, `require-curated-public-facade`, `no-inventory-barrel`, `no-export-star-boundary` | uncurated or oversized public surfaces |
| `no-public-vendor-type-leak`, `no-public-infra-type-leak`, `require-boundary-owned-types` | third-party types leaking into public contracts |
| `no-large-folder`, `folder-readme-required`, `folder-explicit-api-required` | folder hygiene |
| `file-implicit-boundary-module`, `shared-kernel-cohesion`, `no-trivial-sink-file`, `no-fat-orchestrator` | module-shape smells |

## Exception directives

Suppress a rule for one file with a comment pair — the `reason:` line is
mandatory and its absence is itself a diagnostic:

```ts
// @agent-code-guard/architecture-exception: no-trivial-sink-file
// reason: audio.ts is the deliberate single owner of per-scene concat.
```

The directive namespace keeps the `agent-code-guard` prefix for
compatibility with code written against the rules' previous home in
`eslint-plugin-agent-code-guard`.

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # builds, then vitest (fixture projects + LSP handshake)
npm run lint    # knip via agent-code-guard-knip
```

Publishing: push a `vX.Y.Z` tag matching `package.json` version;
`.github/workflows/publish.yml` publishes to npm via trusted publishing.

## Provenance

Extracted from [chughtapan/brief](https://github.com/chughtapan/brief)
(`lsp/architecture`), where it ran as the vendored architecture sidecar
of the brief Claude Code plugin; the rules originated as the
architecture preset of `eslint-plugin-agent-code-guard` before that
preset was retired. This repository is now the sole home of the
analyzer and server.
