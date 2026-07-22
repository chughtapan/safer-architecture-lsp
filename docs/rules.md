# Architecture rules

Reference for every rule in `safer-architecture-lsp`. Each finding's
`ruleId` matches a `##` heading here, so a diagnostic can deep-link to
`docs/rules.md#<rule-id>`.

The analyzer builds a folder-level import graph over a `ts.Program` and
runs one pass per family: package exports, inventory barrels, type
leaks, public surface, folder graph, folder shape, module shape. A
finding is attached to a single file and carries a severity:

- **error** — a hard boundary violation (vendor/infra types in the
  public contract, root/internal cycle, wildcard export).
- **warn** — a shape or budget smell that usually wants a refactor but
  can be a deliberate, reasoned exception.

Rules whose only knobs are hard-coded constants read no config; where a
rule reads options, the option names and defaults below come from
`src/analyzer/project/config-schema.ts`, verified against the pass that
consumes them.

## Suppressing a rule

Silence one rule for one file with a single-line comment. The reason is
mandatory — writing it *is* the architectural decision, and its absence
is itself a diagnostic (`architecture-directive-parse-error`):

```ts
// safer-arch-ignore no-trivial-sink-file: audio.ts is the deliberate single owner of per-scene concat.
```

The suppression is **file-scoped**: it applies to every finding of that
rule in the file, wherever the comment sits. Prefer a config allowance
(with its own `reason`) when the exception is a standing policy for the
whole project; use an in-source suppression for a one-off. Everything
below the top table gives the exact `safer-arch-ignore` line per rule.

The retired two-line `@agent-code-guard/architecture-exception` marker is
never honored; leaving one in place is itself a parse error, so a stale
suppression fails loudly instead of silently lapsing.

## Index

| Rule id | Category | Default trigger | Controlling options |
|---|---|---|---|
| [no-inventory-barrel](#no-inventory-barrel) | Exports | `index.ts` re-exports ≥4 siblings and ≥60% of eligible siblings | `minExportedSiblingModules`, `maxExportedSiblingRatio`, `countTypeOnlyExports` |
| [no-internal-subpath-export](#no-internal-subpath-export) | Package exports | >5 public subpaths, or any wildcard export | `maxSubpathExports`, `maxWildcardExports`, `forbiddenSubpathSegments`, `allowedPublicSubpaths` |
| [no-public-vendor-type-leak](#no-public-vendor-type-leak) | Type boundaries | public API re-exports or returns a non-allowed external package's types | `publicTypePackages`, `packageRuntime` |
| [no-export-star-boundary](#no-export-star-boundary) | Public surface | a public or `index` module uses `export *` | Not configurable |
| [no-folder-cycle](#no-folder-cycle) | Folder graph | production folders form an import cycle | Not configurable |
| [no-root-internal-cycle](#no-root-internal-cycle) | Folder graph | root (`.`) and an `internal` folder import each other | Not configurable |
| [no-large-public-surface](#no-large-public-surface) | Public surface | a public module exports >20 symbols or >12 local re-exports | `maxPublicExports`, `maxPublicReexports` |
| [no-cross-domain-sibling-import](#no-cross-domain-sibling-import) | Layering | an import crosses sibling top-level domains | `sharedFolderNames`, `layers` |
| [no-upward-layer-import](#no-upward-layer-import) | Layering | inert until `layers` is set; then a deeper layer imports a shallower one | `layers` |
| [no-public-test-helper-leak](#no-public-test-helper-leak) | Package exports | public API exposes a test-only path or module | `allowedTestPublicSubpaths` |
| [no-implementation-file-public-entry](#no-implementation-file-public-entry) | Package exports | inert until `implementationPathSegments` is set | `implementationPathSegments`, `allowedPublicSubpaths` |
| [no-public-infra-type-leak](#no-public-infra-type-leak) | Type boundaries | inert until `infrastructureTypePackages` is set | `infrastructureTypePackages` |
| [no-package-mesh](#no-package-mesh) | Folder graph | ≥6 production folders with edge density >0.35 or any cycle group | `minPackageMeshFolders`, `maxFolderEdgeDensity`, `maxFolderCycles` |
| [no-large-folder](#no-large-folder) | Folder shape | >10 production children (or >20 incl. tests, or >20 unpaired tests) | `maxFolderChildren`, `maxFolderChildrenIncludingTests`, `maxUnpairedTestChildren`, `folderChildCountOverrides` |
| [folder-readme-required](#folder-readme-required) | Folder shape | ≥4 semantic children and no `README.md` | `minFolderReadmeChildren`, `folderReadmeFileNames` |
| [no-distant-folder-import](#no-distant-folder-import) | Layering | an import spans >4 folder hops | `maxFolderImportDistance` |
| [require-curated-public-facade](#require-curated-public-facade) | Public surface | a public `index` uses `export *` or has ≥6 local re-exports | `minPublicFacadeModules` |
| [require-boundary-owned-types](#require-boundary-owned-types) | Type boundaries | a public module re-exports or names a non-allowed external package | `publicTypePackages`, `packageRuntime` |
| [folder-explicit-api-required](#folder-explicit-api-required) | Folder shape | a folder is consumed from outside through ≥2 concrete (non-facade) files | `minExplicitApiConcreteFiles`, `sharedFolderNames`, `facadeFiles` |
| [file-implicit-boundary-module](#file-implicit-boundary-module) | Module shape | a non-index module has ≥2 exports, ≥2 incoming, ≥2 outgoing impl files | `minImplicitBoundaryExports`, `minImplicitBoundaryIncomingFiles`, `minImplicitBoundaryOutgoingFiles`, `facadeFiles` |
| [shared-kernel-cohesion](#shared-kernel-cohesion) | Module shape | ≥6 consumed exports, ≥4 consumers, median consumer overlap <0.25 | `minSharedKernelExports`, `minSharedKernelConsumers`, `maxSharedKernelMedianOverlap`, `facadeFiles` |
| [no-trivial-sink-file](#no-trivial-sink-file) | Module shape | non-facade file with 1–2 exports, ≤5 statements, exactly 1 consumer | `facadeFiles` (thresholds fixed) |
| [no-fat-orchestrator](#no-fat-orchestrator) | Module shape | non-entry file with ≥15 imports, ≥20 statements, ≤1 consumer | Not configurable |
| [architecture-directive-parse-error](#architecture-directive-parse-error) | Directives | a malformed, legacy, or reason-less suppression comment | Not configurable |
| [architecture-analysis-unavailable](#architecture-analysis-unavailable) | Health | the TypeScript program could not be built (missing/invalid tsconfig) | Not configurable |

---

## no-inventory-barrel

**Flags.** An `index.*` barrel that re-exports most of its own folder.
The pass counts *eligible* sibling modules (non-test, non-generated,
non-`index` files plus subfolders that themselves have an `index`) and
the subset the barrel re-exports via `export … from "./sibling"`. It
fires when the barrel re-exports at least `minExportedSiblingModules`
siblings **and** the exported/eligible ratio reaches
`maxExportedSiblingRatio`. Message: `… exports N of M eligible sibling
modules. This exports inventory, not an abstraction. Export a smaller
facade: ports, factories, and stable types only.` Severity `warn`.

**Why.** A barrel that mirrors the directory listing is discipline
skipped — the boundary should be a curated choice, not "everything the
folder happens to contain."

**Options.** `minExportedSiblingModules` (default `4`),
`maxExportedSiblingRatio` (default `0.6`), `countTypeOnlyExports`
(default `true` — when `false`, type-only re-exports don't count toward
the exported set).

**Fix.** Re-export only the folder's real contract (ports, factories,
stable types, registries) and let callers reach the rest through those.
Split unrelated concerns into separate barrels.

**Suppress:** `// safer-arch-ignore no-inventory-barrel: <reason>`

## no-internal-subpath-export

**Flags.** `package.json` `exports`/`main`/`types` entries that leak
implementation shape. Three independent checks share this id:

- **Forbidden segment** (severity `error`): a public path or its target
  contains a segment listed in `forbiddenSubpathSegments`. Message:
  `package.json export "<path>" exposes implementation path "<target>".
  Public exports should be curated entrypoints, not
  src/internal/utils/helpers.`
- **Subpath budget** (severity `warn`): the number of unique public
  subpaths (excluding `.`) exceeds `maxSubpathExports`. Message:
  `package.json exposes N public subpaths. The default budget is 5; a
  growing subpath list turns the filesystem into public API.`
- **Wildcard** (severity `error`): more wildcard (`*`) entries than
  `maxWildcardExports`. Message: `package.json export "<path>" is a
  wildcard public surface. Wildcard exports make implementation files
  importable by consumers.`

Any entry whose public path is in `allowedPublicSubpaths` is exempt.

**Why.** The public subpath list is a hard budget; each entry is a
promise you must keep, and wildcards or `internal/` paths hand out
promises you never meant to make.

**Options.** `maxSubpathExports` (default `5`), `maxWildcardExports`
(default `0` — so any wildcard fires), `forbiddenSubpathSegments`
(default `[]` — the segment check is inert until you name segments such
as `internal`, `utils`, `helpers`), `allowedPublicSubpaths` (allowance
list, default `[]`; each entry `{ subpath, reason }`).

**Fix.** Collapse implementation subpaths behind a small set of named
entrypoints. Replace wildcards with explicit paths. Add a
`{ subpath, reason }` allowance for a subpath that is genuinely part of
the contract.

**Suppress:** `// safer-arch-ignore no-internal-subpath-export: <reason>`

## no-public-vendor-type-leak

**Flags.** A public API file that puts an external package's types into
the contract. Two detectors run over the public entrypoints:

- **Re-export**: `export … from "some-package"` (severity `error`;
  `warn` for `node`).
- **Exported signature**: an exported symbol whose type (walked up to 8
  levels through unions, type args, call/construct signatures, and
  properties) references a type declared in an external package
  (severity `error`; `warn` when the package is `node` or a
  `peerDependency`).

Message: `Public API export "<name>" references "<pkg>" types. Wrap
vendor types behind domain-owned public types, or list the package in
publicTypePackages when it is intentionally part of the contract.`

**Why.** The contract should speak your package's vocabulary; a vendor
type crossing the boundary un-translated couples every consumer to a
dependency choice they never opted into.

**Options.** `publicTypePackages` (allowance list, default `[]`; each
entry `{ package, reason }` marks a package as intentionally part of the
contract). `packageRuntime` (default `"universal"`) — `node` builtins
are allowed only when `packageRuntime` is `"node"`.

**Fix.** Define a package-owned type that mirrors the shape you need and
translate at the adapter edge, or add a `{ package, reason }` allowance
when the vendor type is deliberately public (e.g. a re-exported schema
library).

**Suppress:** `// safer-arch-ignore no-public-vendor-type-leak: <reason>`

## no-export-star-boundary

**Flags.** A module that is a public entrypoint or an `index` barrel and
contains one or more `export *` declarations. Message: `… uses N
export-star boundary declaration(s). export * makes the boundary inherit
every future export from the target module.` Severity `warn`.

**Why.** `export *` at a boundary is discipline deferred — the surface
silently grows with the target instead of being a chosen set of names.

**Options.** Not configurable; suppress per-file if needed.

**Fix.** Replace `export *` with an explicit named re-export list so the
boundary states exactly what it promises.

**Suppress:** `// safer-arch-ignore no-export-star-boundary: <reason>`

## no-folder-cycle

**Flags.** A dependency cycle among production folders. The pass
collapses file imports to folder edges (over non-test files), then finds
strongly connected components of size >1. One finding per cycle group.
Message: `Folder dependency cycle: a <-> b <-> c. Folders should expose
a stable direction of knowledge; cycles make every folder in the
component part of the same abstraction.` Severity `warn`.

**Why.** A one-way flow of knowledge is the whole point of a folder
boundary; a cycle means the folders are really one tangled unit and a
shared need should be escalated up, not routed in a loop.

**Options.** Not configurable; suppress per-file if needed. (Structural
— derived from the import graph.)

**Fix.** Break the loop by moving the shared piece into a lower folder
both depend on, or invert one edge behind a facade/port so knowledge
flows one way.

**Suppress:** `// safer-arch-ignore no-folder-cycle: <reason>`

## no-root-internal-cycle

**Flags.** The special case where the source root (`.`) and an
`internal` folder sit in the same folder cycle — root files import
internal files that import back through the root. One finding for the
whole project. Message: `Root files and internal files depend on each
other. The public/root layer should hide internal decisions; internal
code should not import back through it.` Severity `error`.

**Why.** The root/public layer exists to hide internal decisions; if
internal code reaches back through it, the concealment is a fiction and
the two layers have collapsed into one.

**Options.** Not configurable; suppress per-file if needed.

**Fix.** Make `internal` depend only downward. Move anything the root
and internal code share into a neutral module neither treats as "the
public layer."

**Suppress:** `// safer-arch-ignore no-root-internal-cycle: <reason>`

## no-large-public-surface

**Flags.** A public entrypoint that exposes too much. Two checks, both
`warn`:

- exported symbol count > `maxPublicExports`. Message: `… exports N
  public symbols. The default budget is 20; split concrete surfaces
  behind narrower, named entrypoints.`
- local re-export count > `maxPublicReexports`. Message: `… re-exports N
  local modules. The default budget is 12; a root entrypoint should
  curate a contract, not load the package graph.`

**Why.** Public surface is a hard budget; every exported name is
long-term support weight, so growth should be a deliberate decision, not
accretion.

**Options.** `maxPublicExports` (default `20`), `maxPublicReexports`
(default `12`).

**Fix.** Move rarely used or advanced exports behind a secondary named
entrypoint, or drop them from the contract. Keep the root to the small
set of names most consumers need.

**Suppress:** `// safer-arch-ignore no-large-public-surface: <reason>`

## no-cross-domain-sibling-import

**Flags.** A production `import` whose source and target live in
different top-level folders (sibling domains), where neither top folder
is the root and neither is a declared shared kernel. When `layers` is
configured and *both* endpoints resolve to a layer, this rule stands
down and layering governs instead. Message: `… imports … across sibling
domains (a -> b). Sibling features should meet through a facade,
registry, or shared kernel.` Severity `warn`.

**Why.** Two sibling domains reaching into each other route around the
boundary; a shared need should escalate up to a facade or shared kernel
rather than wiring domains together sideways.

**Options.** `sharedFolderNames` (allowance list, default `[]`; each
`{ folder, reason }` marks a top folder as a shared kernel that siblings
may import). `layers` — when both endpoints are layered, the layer rule
takes over.

**Fix.** Introduce a facade, registry, or shared-kernel folder the
siblings both depend on, or declare the target a shared kernel via a
`{ folder, reason }` allowance when that is the real intent.

**Suppress:** `// safer-arch-ignore no-cross-domain-sibling-import: <reason>`

## no-upward-layer-import

**Flags.** An `import` that runs against the configured layer order.
Each folder gets a 0-based layer index by longest-prefix match against
`layers[i].folders` (ties resolve to the earlier layer). The rule fires
when the importer's layer index is **greater** than the importee's —
i.e. a deeper, later-listed layer importing a shallower, earlier-listed
one. Test-like importers are ignored. Message: `… (layer 'X') imports
upward into … (layer 'Y'). Lower-numbered layers must not depend on
higher-numbered ones; move the shared contract into a deeper layer or
invert the dependency.` Severity `warn`.

Order `layers` outermost-first (e.g. `entrypoint`, `app`, `domain`,
`adapters`, `shared`); the allowed direction is an earlier-listed layer
importing a later-listed one, and the violation is the reverse.

**Why.** Layers exist to fix one dependency direction; an import that
runs backward routes around that contract instead of escalating the
shared need down into a layer both sides may depend on.

**Options.** `layers` (default `[]` — the rule is inert until you define
layers; each `{ name, folders, reason }`).

**Fix.** Move the shared contract into a deeper (later-listed) layer so
the dependency points the allowed way, or invert the edge behind a port
the deeper layer owns.

**Suppress:** `// safer-arch-ignore no-upward-layer-import: <reason>`

## no-public-test-helper-leak

**Flags.** Test-only shape reaching consumers through the public API.
Two detectors share this id:

- **package.json** (severity `warn`): a public export whose path or
  target contains a test-only segment (`test`, `tests`, `testing`,
  `test-utils`, `test-support`, `fixtures`, `__fixtures__`, `__tests__`)
  and is not in `allowedTestPublicSubpaths`. Message: `package.json
  export "<path>" exposes test-only path "<target>". Test helpers need
  an explicitly allowed testing subpath so consumers do not treat them
  as production API.`
- **Public surface** (severity `warn`): a public module re-exports a
  test-like module. Message: `… is part of the public package API and
  exposes test-only shape. Test helpers should live behind an
  explicitly allowed testing subpath.`

**Why.** Shipping test helpers as production API is discipline skipped —
consumers will build on scaffolding you meant to keep private.

**Options.** `allowedTestPublicSubpaths` (allowance list, default `[]`;
each `{ subpath, reason }`). The test-only segment list is fixed. The
public-surface re-export detector is structural and not configurable.

**Fix.** Route test helpers through a dedicated, declared testing
subpath (`./testing`) added to `allowedTestPublicSubpaths`, or stop
re-exporting them from the production entrypoint.

**Suppress:** `// safer-arch-ignore no-public-test-helper-leak: <reason>`

## no-implementation-file-public-entry

**Flags.** A `package.json` export whose public path or target contains
a segment listed in `implementationPathSegments`, and whose public path
is not in `allowedPublicSubpaths`. Message: `package.json export
"<path>" points at implementation-shaped path "<target>". Public
entrypoints should be named for the contract they provide, not the
concrete file or pattern behind it.` Severity `warn`.

**Why.** An entrypoint named after its implementation is discipline
skipped — it locks the concrete file into the contract and invites
consumers to depend on how it's built, not what it promises.

**Options.** `implementationPathSegments` (default `[]` — inert until
you name segments such as `impl`, `dist`, `lib`). `allowedPublicSubpaths`
(allowance list, default `[]`).

**Fix.** Rename the export for the contract it provides and point it at
a curated entrypoint, or allow the subpath via
`{ subpath, reason }` when the implementation name is intended.

**Suppress:** `// safer-arch-ignore no-implementation-file-public-entry: <reason>`

## no-public-infra-type-leak

**Flags.** A public API that references an infrastructure package listed
in `infrastructureTypePackages`. It rides on the vendor-type-leak walk:
whenever a public re-export or exported signature touches a package on
the infrastructure list, this stricter finding is emitted alongside.
Message: `Public API references infrastructure package "<pkg>".
Database, logging, transport, and SDK implementation choices should be
hidden behind package-owned ports or DTOs.` Severity `error`.

**Why.** Infrastructure choices — the database client, logger,
transport, SDK — are exactly the decisions a boundary should hide;
leaking their types nails the choice into your public contract.

**Options.** `infrastructureTypePackages` (allowance/strictness list,
default `[]`; each `{ package, reason }` names a package as
infrastructure). The rule is inert until the list is populated.

**Fix.** Wrap the infrastructure type in a package-owned port or DTO and
expose that instead; translate to the infra type only inside the
adapter.

**Suppress:** `// safer-arch-ignore no-public-infra-type-leak: <reason>`

## no-package-mesh

**Flags.** A whole-package shape that is a web rather than a stack. Once
the project has at least `minPackageMeshFolders` production folders, the
pass fires if folder-edge **density** exceeds `maxFolderEdgeDensity` or
the number of folder cycle groups exceeds `maxFolderCycles`. Density is
distinct directed folder pairs over all possible ordered pairs. One
finding for the project. Message: `Package folder graph has N production
folders, E production folder edges, C cycle groups, and density D. This
is a mesh, not a layered package shape.` Severity `warn`.

**Why.** When every folder can reach every other, there is no settled
direction to escalate along; the package has become one large
implicit unit.

**Options.** `minPackageMeshFolders` (default `6`), `maxFolderEdgeDensity`
(default `0.35`), `maxFolderCycles` (default `0`).

**Fix.** Introduce layering or a shared kernel so dependencies flow one
way. Reduce cross-folder edges by having folders meet through facades
instead of reaching into each other directly.

**Suppress:** `// safer-arch-ignore no-package-mesh: <reason>`

## no-large-folder

**Flags.** A folder with too many direct children. It fires if any of:
production children > `maxFolderChildren`; children including tests >
`maxFolderChildrenIncludingTests`; unpaired test children (tests with no
same-named production sibling) > `maxUnpairedTestChildren`. Children
count subfolders and file stems; explicit facades aren't counted as a
file child of their own folder. Message: `src/<folder> has N direct
production children (max M), … including tests (max …), and … unpaired
test children (max …): a, b, c. Split broad package-tree folders into
semantic subfolders or pair tests with the code they exercise.` Severity
`warn`.

**Why.** Folder size is a hard budget; past a point the folder stops
being a boundary and becomes a junk drawer whose name promises nothing.

**Options.** `maxFolderChildren` (default `10`),
`maxFolderChildrenIncludingTests` (default `20`),
`maxUnpairedTestChildren` (default `20`). `folderChildCountOverrides`
(default `[]`; per-folder `{ folder, maxChildren?,
maxChildrenIncludingTests?, maxUnpairedTestChildren?, reason }` to raise
or lower any of the three budgets for one folder).

**Fix.** Group children into semantic subfolders, each with its own
boundary. Co-locate tests with the code they exercise so they pair off,
or add a `folderChildCountOverrides` entry when a flat folder is
justified.

**Suppress:** `// safer-arch-ignore no-large-folder: <reason>`

## folder-readme-required

**Flags.** A folder with at least `minFolderReadmeChildren` direct
semantic (production) children but none of the configured README file
names present. The finding attaches to the folder's first file.
Message: `src/<folder> has N direct semantic children (threshold M) but
no configured README file. Add src/<folder>/README.md describing the
folder boundary, or split the folder.` Severity `warn`.

**Why.** A folder big enough to be a boundary owes a one-paragraph
statement of what that boundary is; skipping it is discipline skipped.

**Options.** `minFolderReadmeChildren` (default `4`),
`folderReadmeFileNames` (default `["README.md"]`; the first entry is
used in the suggested path).

**Fix.** Add a short README naming the folder's responsibility and its
public contract, or split the folder if it has no single boundary to
describe.

**Suppress:** `// safer-arch-ignore folder-readme-required: <reason>`

## no-distant-folder-import

**Flags.** A production `import` whose source and target folders are far
apart in the tree. Distance is tree hops: depth of each folder summed,
minus twice their common-prefix depth. It fires when distance exceeds
`maxFolderImportDistance`. Test-like and generated modules on either end
are ignored. Message: `… imports … across N folder hops (max M). Use a
nearer facade/port instead of reaching from src/<a> into src/<b>.`
Severity `warn`.

**Why.** A long reach across the tree routes around every boundary in
between; the need should escalate to a nearer shared facade rather than
tunnel straight through.

**Options.** `maxFolderImportDistance` (default `4`).

**Fix.** Depend on a nearer facade or port that re-exports what you
need, or relocate the shared piece closer to both folders.

**Suppress:** `// safer-arch-ignore no-distant-folder-import: <reason>`

## require-curated-public-facade

**Flags.** A public `index` barrel that is doing bulk wiring instead of
curation: it either contains `export *` **or** has at least
`minPublicFacadeModules` local re-exports. Message: `… is a public
facade but exposes N local re-export(s) and M export-star declaration(s).
Public facades should name a small semantic contract: ports, factories,
stable types, and registries.` Severity `warn`.

**Why.** A public facade is a curated promise, not a loader; wildcards
and long re-export lists are the facade abdicating that choice.

**Options.** `minPublicFacadeModules` (default `6`).

**Fix.** Reduce the facade to the small set of names that form the
contract; move the rest behind their own boundaries and drop `export *`
in favor of explicit names.

**Suppress:** `// safer-arch-ignore require-curated-public-facade: <reason>`

## require-boundary-owned-types

**Flags.** A public module that names an external package directly,
detected two ways (both severity `error`):

- **Re-export**: `export … from "some-package"` on a public module.
  Message: `… re-exports "<pkg>" directly. Public boundaries should
  expose package-owned names and wrap vendor or infrastructure types.`
- **Exported declaration**: a public module imports an identifier from a
  non-allowed external package and then references it in an exported
  declaration. Message: `… export "<name>" mentions "<pkg>" directly.
  Define a boundary-owned type and translate at the adapter edge.`

**Why.** The boundary should own its vocabulary; re-exporting or naming
a vendor type directly ships someone else's schema as your contract with
no translation at the edge.

**Options.** `publicTypePackages` (allowance list, default `[]`; each
`{ package, reason }`). `packageRuntime` (default `"universal"`) — `node`
is allowed only when set to `"node"`.

**Fix.** Introduce a boundary-owned type (interface, DTO, or wrapper)
and translate to the vendor type inside the adapter, or add a
`{ package, reason }` allowance when the vendor name is intentionally
public.

**Suppress:** `// safer-arch-ignore require-boundary-owned-types: <reason>`

## folder-explicit-api-required

**Flags.** A folder that outside code consumes by reaching into its
concrete files rather than through a facade. The pass counts distinct
concrete target files (non-facade, non-test, non-generated) in the
folder that are imported from outside it; it fires when that count
reaches `minExplicitApiConcreteFiles`, unless a dominant share (≥80%) of
the outside consumers already go through the folder's facade. Shared
folders are exempt. Message: `src/<folder> is being consumed as a folder
API through N concrete files. Add src/<folder>/index.ts, or list a
deliberate non-index facade in architecture facadeFiles and make outside
code import it.` Severity `warn`.

**Why.** A folder consumed through several of its internal files has no
enforced surface; the budget for what's public should be one deliberate
facade, not "whichever files callers happened to import."

**Options.** `minExplicitApiConcreteFiles` (default `2`).
`sharedFolderNames` (allowance, default `[]`; shared folders and their
descendants are skipped). `facadeFiles` (default `[]`; `{ file, reason }`
declares a non-`index` file as the folder's facade — `index.ts` is
always a facade).

**Fix.** Add an `index.ts` that re-exports the folder's contract and
have outside code import that, or declare a deliberate non-index facade
via a `{ file, reason }` `facadeFiles` entry.

**Suppress:** `// safer-arch-ignore folder-explicit-api-required: <reason>`

## file-implicit-boundary-module

**Flags.** A non-`index` file that behaves like a boundary without being
declared one. It fires when the module is not a facade, test, or
generated file and has: exported symbols ≥ `minImplicitBoundaryExports`,
incoming production files ≥ `minImplicitBoundaryIncomingFiles`, and
outgoing implementation files (non-public production targets) ≥
`minImplicitBoundaryOutgoingFiles`. Message: `… acts like a boundary
module: N production files depend on it, it depends on M implementation
files, and it exports K names. Move the stable API to index.ts, or list
a deliberate non-index facade in architecture facadeFiles.` Severity
`warn`.

**Why.** A file that many callers depend on and that fans out into
implementation is a boundary in all but name; leaving it undeclared
means the boundary's breadth grows with nobody having decided it should.

**Options.** `minImplicitBoundaryExports` (default `2`),
`minImplicitBoundaryIncomingFiles` (default `2`),
`minImplicitBoundaryOutgoingFiles` (default `2`). `facadeFiles`
(default `[]`) — declaring the file a facade exempts it.

**Fix.** Promote the stable API to an `index.ts` boundary, or declare
this file a facade via a `{ file, reason }` `facadeFiles` entry so its
boundary role is intentional.

**Suppress:** `// safer-arch-ignore file-implicit-boundary-module: <reason>`

## shared-kernel-cohesion

**Flags.** A module used as a shared kernel whose exports don't actually
belong together. Over its production consumers, the pass needs ≥
`minSharedKernelExports` consumed exports and ≥ `minSharedKernelConsumers`
total consumers; it then computes pairwise Jaccard overlap of the
consumer sets of each export pair and fires when the **median** overlap
is below `maxSharedKernelMedianOverlap`. Message: `… has N production
exports but low consumer overlap across export families (median D across
P pairs). a/b, c/d are used by mostly different modules. Split cohesive
helper modules or expose a small facade.` Severity `warn`.

**Why.** A shared kernel earns its place by serving one coherent need;
if its exports are consumed by disjoint audiences it's a grab-bag, and
discipline says split it.

**Options.** `minSharedKernelExports` (default `6`),
`minSharedKernelConsumers` (default `4`),
`maxSharedKernelMedianOverlap` (default `0.25`). `facadeFiles`
(default `[]`) — a declared facade is exempt.

**Fix.** Split the module along its consumer clusters into cohesive
helper modules, or wrap the genuinely shared subset behind a small
facade and move the rest closer to their callers.

**Suppress:** `// safer-arch-ignore shared-kernel-cohesion: <reason>`

## no-trivial-sink-file

**Flags.** A tiny file that exists only to be imported once. It fires
for a non-`index`, non-public, non-test, non-generated, non-facade
module with 1–2 exports and ≤5 top-level statements (and not a pure
barrel) that has exactly one consumer file — unless that sole consumer
only re-exports it. Message: `… has 1 consumer (<consumer>) and a
trivial surface (N exports, M top-level statements). Inline its contents
at the call site to remove the indirection, or expose it via a barrel if
it is meant to be public.` Severity `warn`.

**Why.** A one-line file with one caller is indirection without a
boundary — discipline says the split should earn its keep or be inlined.

**Options.** The thresholds (≤2 exports, ≤5 statements, 1 consumer) are
fixed. A file listed in `facadeFiles` (or any `index.ts`) is exempt.
Otherwise not configurable — suppress per-file if the split is
deliberate.

**Fix.** Inline the file at its single call site, or, if it's meant to
be a real boundary, give it a barrel and more than one consumer.

**Suppress:** `// safer-arch-ignore no-trivial-sink-file: <reason>`

## no-fat-orchestrator

**Flags.** A non-entry file shaped like top-level wiring. It fires for a
module that is not test, `index`, public, generated, or on an entry path
(`bin/`, `cli/`, `main`/`cli`/`index` files, `*.config.*`) when its
fan-out (local + external imports) is ≥15, its top-level statement count
is ≥20, and it has ≤1 consumer. Message: `… is shaped like an
orchestrator (N imports, M top-level statements, K consumers) but is not
an entry point. Either declare it as an entry point (index/main/cli,
public surface, or move under bin/cli/) or split the wiring into focused
submodules.` Severity `warn`.

**Why.** Broad wiring belongs at a declared entry point; a hidden
orchestrator concentrates the whole assembly in a file nobody treats as
the top, which is capability without the discipline of a named seam.

**Options.** Not configurable; the thresholds are fixed and the pass
ignores config. Suppress per-file, or make the file a genuine entry
point.

**Fix.** Declare it an entry point (rename to `index`/`main`/`cli`, move
under `bin/`/`cli/`, or make it public), or split the wiring into
focused submodules that each own one concern.

**Suppress:** `// safer-arch-ignore no-fat-orchestrator: <reason>`

## architecture-directive-parse-error

**Flags.** A broken in-source suppression comment. This is a
pseudo-rule: it isn't in the rule registry and can't itself be
suppressed — it's reported so a broken `safer-arch-ignore` is never
silently ignored. Severity `error`. It fires for any of:

- a **legacy** `@agent-code-guard/architecture-exception` marker (never
  honored — rewrite it): `Legacy '@agent-code-guard/architecture-exception'
  directives are not honored. Rewrite as 'safer-arch-ignore <rule-id>:
  <reason>'.`
- a **malformed** `safer-arch-ignore` line that doesn't match
  `safer-arch-ignore <rule-id>: <reason>`: `Malformed 'safer-arch-ignore'
  directive. Expected 'safer-arch-ignore <rule-id>: <reason>' on one
  comment line.`
- an **unknown rule id**: `Unknown architecture rule id '<id>' in
  directive. Expected one of: …`
- an **empty reason**: `Empty reason for directive 'safer-arch-ignore
  <rule-id>: <reason>'. The written reason is mandatory.`

A suppression that names a *valid* rule but fails to parse still
silences that rule for the file (so a typo'd reason doesn't reopen a
finding you meant to waive) while this parse error points you at the fix.

**Why.** A suppression is an architectural decision on the record; a
broken one must fail loudly rather than quietly grant or drop a waiver.

**Options.** Not configurable; fix the comment.

**Fix.** Write the suppression as `// safer-arch-ignore <rule-id>:
<reason>` with a real rule id (see the index above) and a non-empty
reason.

## architecture-analysis-unavailable

**Flags.** The analyzer could not build a TypeScript program, so no
architecture analysis ran. This pseudo-rule turns that into a loud
finding rather than an empty, falsely-clean report. It fires when
`programHealth` is not `ok` — `missing-tsconfig` (no `tsconfig.json` at
or above the project root) or `invalid-tsconfig` (the tsconfig failed to
parse). The finding attaches to the offending config path, or
`<root>/tsconfig.json` when none was found. Message: `Architecture
analysis did not run: <detail>. Fix the TypeScript project
configuration; until then this workspace has NO architecture coverage.`
Severity `error`.

**Why.** A guardrail must never present a can't-analyze state as a clean
bill of health; silence here would read as "no problems" when it really
means "no coverage."

**Options.** Not configurable. Resolving it is a project-config fix, not
a rule setting.

**Fix.** Add a `tsconfig.json` at the project root (or point
`tsconfigPath` at the right one) and fix any parse errors it reports so
the analyzer can build a program.
