# Agent Code Guard 0.0.21 Migration Handoff

## Goal

Migrate this repository from `eslint-plugin-agent-code-guard@^0.0.14` to the
published `0.0.21` release and adopt its current `recommended` ESLint policy.
This is more than a dependency bump: the repository currently runs only the
package's Knip launcher, while `0.0.21` defines a type-aware, blocking ESLint
floor.

Do this after the CUPID/workspace branch lands. That branch is already 54 files
and roughly 3,000 added lines; mixing the lint migration into it would make both
changes harder to review and revert.

## Current State

- Branch reviewed: `feat/cupid-architecture-enforcement`
- Comparison base: freshly fetched `origin/main`
- Branch position: 11 commits ahead, 0 behind
- Current dependency: `eslint-plugin-agent-code-guard@^0.0.14`
- Current lint command: `agent-code-guard-knip`
- No committed ESLint flat config
- Root `tsconfig.json` includes `src/**/*` and excludes `tests/`
- CI already runs `npm test`, `npm run lint`, and the architecture self-check
- Existing Knip lint and architecture self-check pass with `0.0.21`

An isolated rehearsal of the `0.0.21` `recommended` preset found about 1,391
blocking errors. `eslint --fix` removed 636, leaving 755 errors across 84 files:

- 610 in `src/`
- 141 in `tests/`
- 4 in `vitest.config.ts`

The largest remaining groups were export JSDoc, declaration ordering, stable
file shells, generic `void`, hardcoded test assertions, JavaScript private
identifiers, assertion rationales, and async/Promise rules.

## Required Sequence

### 1. Land the existing feature branch first

1. Merge `feat/cupid-architecture-enforcement` without the guard migration.
2. Create a fresh migration branch from the updated `main`.
3. Confirm the worktree is clean and record the starting commit.

This prevents automated lint edits and declaration reordering from obscuring
the CUPID/workspace implementation.

### 2. Establish a clean Node 22 baseline

Use the same Node major version as CI:

```bash
npm ci
npm run build
npm run lint
npm test
node dist/server/index.js check .
```

Record any pre-existing failures before changing dependencies. All 82 tests
pass on Node 22.23.2 (verified 2026-08-12). An earlier isolated review
environment saw the two stdio LSP session tests fail when the child process hit
`EMFILE` while initializing file watchers; that was a file-descriptor limit in
that sandbox, not a product regression. Treat an `EMFILE` failure here as an
environment problem and raise `ulimit -n`.

### 3. Land the dependency-only bump

1. Update `eslint-plugin-agent-code-guard` to `^0.0.21`.
2. Add an explicit ESLint 9 development dependency. Do not rely on npm's
   automatic peer installation.
3. Regenerate `package-lock.json` with the repository's supported npm version.
4. Re-run the baseline commands while keeping the existing Knip-only lint
   script.

Suggested command:

```bash
npm install --save-dev eslint@^9.39.5 eslint-plugin-agent-code-guard@^0.0.21
```

Keep this as its own commit. It proves the package bump itself is harmless
before the policy is activated.

### 4. Add the type-aware lint scaffold

Add `eslint.config.js` using the named export introduced after `0.0.15`:

```js
import { plugin as guard } from "eslint-plugin-agent-code-guard";
```

Start with `guard.configs.recommended`, not `strict`. The recommended preset is
already a large blocking policy; strict adds complexity limits that should be
evaluated after the repository reaches the base floor.

The flat config needs separate blocks for:

1. `src/**/*.ts`, using the preset's bundled parser and `projectService`.
2. `tests/**/*.ts`, using a dedicated `tsconfig.test.json` and
   `projectService: false` with an explicit `project`.
3. Root TypeScript configuration files such as `vitest.config.ts`, using
   `allowDefaultProject` and `tsconfigRootDir: import.meta.dirname`.
4. Repository ignores: `node_modules/**`, `dist/**`, `coverage/**`, cache
   directories, and any generated fixtures.

Add `tsconfig.test.json` extending the production config, with `noEmit: true`
and both `src/**/*.ts` and `tests/**/*.ts` included.

At this stage, invoke ESLint directly to inspect the baseline. Do not wire it
into CI until the policy decisions in the next step are recorded.

### 5. Resolve policy conflicts before mass edits

Make and document these decisions first:

1. **Coverage threshold:** `agent-code-guard/no-coverage-threshold-gate` rejects
   `vitest.config.ts`'s coverage ratchet. Either remove the threshold for full
   upstream compliance or preserve the project decision with a narrow,
   reason-carrying suppression. Do not silently delete the ratchet.
2. **Vitest default export:** the maintained Import-X rules reject default
   exports, while Vitest configuration uses one. Add a file-scoped override for
   config files rather than restructuring application modules around a tool
   convention.
3. **Effect output types:** the preset rejects `void` in generic arguments,
   including `Effect.Effect<void>`. Decide whether to migrate these outputs to
   `undefined`/explicit `Effect.asVoid` boundaries or allowlist the canonical
   Effect generic forms. Apply one rule consistently.
4. **Test policy:** decide whether tests must obey production async/Promise,
   hardcoded-assertion, and property-test rules. The upstream repository itself
   scopes some test relaxations. Every relaxation here should be explicit and
   reasoned.
5. **Migration mode:** either fix the whole recommended floor before enabling
   CI, or introduce temporary rule overrides with a removal checklist. Do not
   leave an untracked blanket disable.

Commit the config and documented decisions separately from source rewrites.

### 6. Apply and review mechanical fixes

Run:

```bash
npx eslint . --fix
```

Review the result before doing manual work. In the rehearsal this removed about
636 findings, mostly braces, import ordering, named import/export ordering, and
array-type syntax.

Verification for this commit:

```bash
npm run build
npm test
node dist/server/index.js check .
```

Pay special attention to side-effect imports and module initialization order.
Keep this commit mechanical: no API redesigns or Effect migrations.

### 7. Fix stable file shells and export documentation

1. Add one substantive canonical `@file` overview per linted TypeScript file.
2. Keep import blocks contiguous.
3. Fence intentional bare side-effect imports with the guard's paired
   evaluation-order markers.
4. Add substantive JSDoc to every top-level exported type, interface, enum,
   class, function, and variable.
5. Add required parameter, property, return, and yield descriptions.
6. Avoid placeholder prose that triggers `no-vacuous-jsdoc`.

Do this by directory or domain so reviews can verify the documentation against
the implementation. Re-run ESLint after each slice.

### 8. Fix TypeScript and Effect policy findings

Handle these in small, behavior-preserving commits:

1. Replace JavaScript `#private` identifiers with TypeScript `private` members.
2. Resolve generic `void` according to the decision from step 5.
3. Replace unsafe assertions with validated narrowing, or add an immediately
   preceding safety rationale where an assertion is truly required.
4. Resolve naming, optional-property, sort-comparator, deprecated API,
   unbound-method, and unsafe-boundary findings.
5. Convert production `async`, `.then`, bare `catch`, and `Promise<T>` flows to
   the repository's canonical Effect patterns where the guard requires it.
6. Preserve existing error channels, resource scopes, and watcher lifecycle
   behavior during Effect rewrites.

Run targeted tests after each directory and the full suite after each commit.

### 9. Migrate tests under the chosen test policy

1. Replace or justify hardcoded assertion literals.
2. Add property/invariant coverage where the rule identifies a real missing
   invariant; use scoped, reasoned exemptions for regression-only suites.
3. Convert test async/Promise helpers only if step 5 kept those rules enabled
   for tests.
4. Replace test `#private` fields and add assertion rationales.
5. Preserve the stdio/LSP timeout diagnostics and make child-process stderr
   visible on failure where practical.

Do not weaken behavioral assertions merely to satisfy the linter.

### 10. Apply vertical declaration ordering last

Resolve `prefer-stepdown-function-order` after semantic edits stabilize:

1. Keep exported declarations before internal declarations.
2. Put direct callers before their local callees.
3. Move recursive components as units.
4. Verify each reorder is relocation-only unless a separate semantic change is
   intentionally documented.

Doing this last avoids repeatedly reordering functions while their call graph is
still changing.

### 11. Activate the quality gate

Once `npx eslint .` is clean:

1. Change `lint` to run ESLint and Knip, for example:

   ```json
   "lint": "eslint . && agent-code-guard-knip"
   ```

2. Keep TypeScript checking explicit through the existing build/test pipeline,
   or add a dedicated `typecheck`/`check` script if one-command local parity is
   desired.
3. Update README development instructions so `npm run lint` is no longer
   described as Knip-only.
4. Keep CI's existing `npm run lint` step; it will now enforce the new floor.

### 12. Run the release-quality verification

Run all of the following under Node 22:

```bash
npm ci
npm run build
npm run lint
npm test
npm run test:coverage
node dist/server/index.js check .
npm pack --dry-run
git diff --check origin/main...HEAD
```

Also inspect the final dependency audit. The rehearsal saw a `nanoid` advisory
through the existing Vitest/PostCSS chain; it is present in the current lockfile
and is not introduced by Agent Code Guard, but it should not be misattributed
during migration review.

## Completion Criteria

The migration is complete when:

- `package.json` and `package-lock.json` resolve Agent Code Guard `0.0.21` and
  explicit ESLint 9.
- The named plugin export and type-aware flat config are committed.
- Source, tests, and root TypeScript config files have intentional lint scope.
- Every override or disable is narrow and carries a written reason.
- `npm run lint` runs both ESLint and Knip and exits cleanly.
- Build, tests, coverage, architecture self-check, and package dry-run pass on
  Node 22.
- README and CI behavior match the commands developers actually run.
- No temporary migration-only disable remains without an owner and removal
  condition.

## Upstream References

- Release notes: <https://github.com/chughtapan/agent-code-guard/blob/v0.0.21/CHANGELOG.md>
- Migration/configuration guide: <https://github.com/chughtapan/agent-code-guard/blob/v0.0.21/README.md#migrating-from-0015>
- npm package: <https://www.npmjs.com/package/eslint-plugin-agent-code-guard>
