/**
 * @file Schema for the architecture rule options: thresholds, layer and
 * domain definitions, and the allowance lists that widen a rule. Decoding
 * happens here so an exception cannot enter the config without the written
 * reason the schema demands alongside it.
 */

import { Schema } from "effect";

const nonEmptyString = Schema.String.pipe(Schema.minLength(1));

// Allowance entries: every architectural exception MUST carry a written
// reason. The act of writing the reason is the architectural decision —
// the schema enforces it at validation time so reviewers see intent in
// the config, not just a bare list.

const publicTypeAllowanceSchema = Schema.Struct({
  package: nonEmptyString.annotations({
    description: "External package whose types are intentionally part of this package's public contract.",
  }),
  reason: nonEmptyString.annotations({
    description: "Why this package is part of the public contract. Goes into config review and CHANGELOG context.",
  }),
});
type PublicTypeAllowance = typeof publicTypeAllowanceSchema.Type;

const infrastructureAllowanceSchema = Schema.Struct({
  package: nonEmptyString.annotations({
    description: "Infrastructure package (database client, logger, transport, etc.) whose types should be flagged in public surfaces.",
  }),
  reason: nonEmptyString.annotations({
    description: "Why this package is on the infrastructure list (not the public contract list).",
  }),
});
type InfrastructureAllowance = typeof infrastructureAllowanceSchema.Type;

const subpathAllowanceSchema = Schema.Struct({
  subpath: nonEmptyString.annotations({
    description: "package.json subpath that is intentionally part of the public contract (e.g., '.', './cli', './testing').",
  }),
  reason: nonEmptyString.annotations({
    description: "Why this subpath is public. Documents intent for future maintainers.",
  }),
});
type SubpathAllowance = typeof subpathAllowanceSchema.Type;

const sharedFolderAllowanceSchema = Schema.Struct({
  folder: nonEmptyString.annotations({
    description: "Folder name treated as a shared kernel; sibling/lower-level folders may import from it without crossing a boundary.",
  }),
  reason: nonEmptyString.annotations({
    description: "Why this folder is a shared kernel rather than a domain.",
  }),
});
type SharedFolderAllowance = typeof sharedFolderAllowanceSchema.Type;

const facadeFileAllowanceSchema = Schema.Struct({
  file: nonEmptyString.annotations({
    description: "Non-index facade file path relative to src (for example, 'rules/registry.ts'). index.ts files are already treated as facades.",
  }),
  reason: nonEmptyString.annotations({
    description: "Why this non-index file is an intentional facade. Documents the boundary for reviewers.",
  }),
});
type FacadeFileAllowance = typeof facadeFileAllowanceSchema.Type;

const packageRuntimeSchema = Schema.Literal("browser", "node", "universal");

const ratio = Schema.Number.pipe(Schema.between(0, 1));
const nonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
const positiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1));

// Defaults — these populate when the option is omitted entirely. Note that
// allowance arrays default to []; consumers MUST add explicit entries with
// reasons. There is no default allowlist.
// Strictness lists (forbiddenSubpathSegments, implementationPathSegments)
// stay as bare strings because adding entries makes the rule STRICTER, not
// more permissive. There is no architectural exception to acknowledge.

const layerDefinitionSchema = Schema.Struct({
  name: nonEmptyString.annotations({
    description: "Layer name (entrypoint, app, domain, adapters, shared, etc.).",
  }),
  folders: Schema.Array(nonEmptyString).annotations({
    description: "Folder paths relative to the project root that belong to this layer. Longest-prefix match wins; ties resolve to the lower (earlier) layer index.",
  }),
  reason: nonEmptyString.annotations({
    description: "Why these folders form a layer. Documents the architectural intent.",
  }),
});
/**
 * One named layer and the folders it claims. Folders may nest across
 * layers, so the longest matching prefix decides which layer a file is in.
 */
export type LayerDefinition = typeof layerDefinitionSchema.Type;

const domainDefinitionSchema = Schema.Struct({
  name: nonEmptyString.annotations({ description: "Stable domain identifier used in diagnostics." }),
  roots: Schema.NonEmptyArray(nonEmptyString).annotations({
    description: "Project-relative file or directory roots whose production modules belong to this domain.",
  }),
  entrypoints: Schema.NonEmptyArray(nonEmptyString).annotations({
    description: "Project-relative public boundary paths other domains may import.",
  }),
  reason: nonEmptyString.annotations({ description: "Why this domain boundary exists." }),
});
/**
 * One bounded domain: the roots whose production modules belong to it, and
 * the narrower set of paths inside those roots that other domains may
 * import. Anything else under the roots is internal to the domain.
 */
export type DomainDefinition = typeof domainDefinitionSchema.Type;

const domainOwnershipSchema = Schema.Struct({
  path: nonEmptyString.annotations({ description: "Project-relative file or directory path." }),
  domain: nonEmptyString.annotations({ description: "Domain that explicitly owns this path." }),
  reason: nonEmptyString.annotations({ description: "Why inferred root ownership is overridden." }),
});
/**
 * An explicit assignment of one path to one domain, overriding the
 * ownership that would otherwise be inferred from the domain roots.
 */
export type DomainOwnership = typeof domainOwnershipSchema.Type;

const compositionRootSchema = Schema.Struct({
  path: nonEmptyString.annotations({
    description: "Project-relative file or directory allowed to wire multiple domains together.",
  }),
  reason: nonEmptyString.annotations({ description: "Why dependency composition belongs at this edge." }),
});
/**
 * A path allowed to depend on several domains at once. Wiring domains
 * together is a boundary violation everywhere else, so it is named here.
 */
export type CompositionRoot = typeof compositionRootSchema.Type;

const folderChildLimitOverrideSchema = Schema.Struct({
  folder: nonEmptyString.annotations({
    description: "Folder path relative to src, or '.' for the source root.",
  }),
  maxChildren: Schema.optional(positiveInt).annotations({
    description: "Maximum direct production/semantic children allowed for this folder.",
  }),
  maxChildrenIncludingTests: Schema.optional(positiveInt).annotations({
    description: "Maximum direct children allowed for this folder when test children are included.",
  }),
  maxUnpairedTestChildren: Schema.optional(nonNegativeInt).annotations({
    description: "Maximum direct unpaired test children allowed for this folder.",
  }),
  reason: nonEmptyString.annotations({
    description: "Why this folder has a different direct-child budget.",
  }),
});
type FolderChildLimitOverride = typeof folderChildLimitOverrideSchema.Type;

const architectureOptionsSchema = Schema.Struct({
  projectRoot: Schema.optional(nonEmptyString),
  tsconfigPath: Schema.optional(nonEmptyString),

  // Inventory barrel thresholds.
  minExportedSiblingModules: positiveInt.pipe(
    Schema.optionalWith({ default: () => 4 }),
  ),
  maxExportedSiblingRatio: ratio.pipe(
    Schema.optionalWith({ default: () => 0.6 }),
  ),
  countTypeOnlyExports: Schema.Boolean.pipe(
    Schema.optionalWith({ default: () => true }),
  ),

  allowedPublicSubpaths: Schema.Array(subpathAllowanceSchema).pipe(
    Schema.optionalWith({ default: (): readonly SubpathAllowance[] => [] }),
  ),
  allowedTestPublicSubpaths: Schema.Array(subpathAllowanceSchema).pipe(
    Schema.optionalWith({ default: (): readonly SubpathAllowance[] => [] }),
  ),

  forbiddenSubpathSegments: Schema.Array(nonEmptyString).pipe(
    Schema.optionalWith({ default: (): readonly string[] => [] }),
  ),
  implementationPathSegments: Schema.Array(nonEmptyString).pipe(
    Schema.optionalWith({ default: (): readonly string[] => [] }),
  ),

  // Public surface caps.
  maxSubpathExports: nonNegativeInt.pipe(
    Schema.optionalWith({ default: () => 5 }),
  ),
  maxWildcardExports: nonNegativeInt.pipe(
    Schema.optionalWith({ default: () => 0 }),
  ),
  maxPublicExports: positiveInt.pipe(
    Schema.optionalWith({ default: () => 20 }),
  ),
  maxPublicReexports: nonNegativeInt.pipe(
    Schema.optionalWith({ default: () => 12 }),
  ),
  minPublicFacadeModules: positiveInt.pipe(
    Schema.optionalWith({ default: () => 6 }),
  ),

  // Folder graph thresholds.
  minPackageMeshFolders: positiveInt.pipe(
    Schema.optionalWith({ default: () => 6 }),
  ),
  maxFolderEdgeDensity: ratio.pipe(
    Schema.optionalWith({ default: () => 0.35 }),
  ),
  maxFolderCycles: nonNegativeInt.pipe(
    Schema.optionalWith({ default: () => 0 }),
  ),
  maxFolderChildren: positiveInt.pipe(
    Schema.optionalWith({ default: () => 10 }),
  ),
  maxFolderChildrenIncludingTests: positiveInt.pipe(
    Schema.optionalWith({ default: () => 20 }),
  ),
  maxUnpairedTestChildren: nonNegativeInt.pipe(
    Schema.optionalWith({ default: () => 20 }),
  ),
  minFolderReadmeChildren: positiveInt.pipe(
    Schema.optionalWith({ default: () => 4 }),
  ),
  folderReadmeFileNames: Schema.Array(nonEmptyString).pipe(
    Schema.optionalWith({ default: (): readonly string[] => ["README.md"] }),
  ),
  maxFolderImportDistance: positiveInt.pipe(
    Schema.optionalWith({ default: () => 4 }),
  ),
  folderChildCountOverrides: Schema.Array(folderChildLimitOverrideSchema).pipe(
    Schema.optionalWith({ default: (): readonly FolderChildLimitOverride[] => [] }),
  ),

  // Boundary-shape heuristics. These are sample-size guardrails; topology
  // remains the primary signal.
  minExplicitApiConcreteFiles: positiveInt.pipe(
    Schema.optionalWith({ default: () => 2 }),
  ),
  minImplicitBoundaryIncomingFiles: positiveInt.pipe(
    Schema.optionalWith({ default: () => 2 }),
  ),
  minImplicitBoundaryOutgoingFiles: positiveInt.pipe(
    Schema.optionalWith({ default: () => 2 }),
  ),
  minImplicitBoundaryExports: positiveInt.pipe(
    Schema.optionalWith({ default: () => 2 }),
  ),
  minSharedKernelExports: positiveInt.pipe(
    Schema.optionalWith({ default: () => 6 }),
  ),
  minSharedKernelConsumers: positiveInt.pipe(
    Schema.optionalWith({ default: () => 4 }),
  ),
  maxSharedKernelMedianOverlap: ratio.pipe(
    Schema.optionalWith({ default: () => 0.25 }),
  ),

  sharedFolderNames: Schema.Array(sharedFolderAllowanceSchema).pipe(
    Schema.optionalWith({ default: (): readonly SharedFolderAllowance[] => [] }),
  ),

  facadeFiles: Schema.Array(facadeFileAllowanceSchema).pipe(
    Schema.optionalWith({ default: (): readonly FacadeFileAllowance[] => [] }),
  ),

  publicTypePackages: Schema.Array(publicTypeAllowanceSchema).pipe(
    Schema.optionalWith({ default: (): readonly PublicTypeAllowance[] => [] }),
  ),

  infrastructureTypePackages: Schema.Array(infrastructureAllowanceSchema).pipe(
    Schema.optionalWith({ default: (): readonly InfrastructureAllowance[] => [] }),
  ),

  layers: Schema.Array(layerDefinitionSchema).pipe(
    Schema.optionalWith({ default: (): readonly LayerDefinition[] => [] }),
  ),

  domains: Schema.Array(domainDefinitionSchema).pipe(
    Schema.optionalWith({ default: (): readonly DomainDefinition[] => [] }),
  ),
  domainOwnership: Schema.Array(domainOwnershipSchema).pipe(
    Schema.optionalWith({ default: (): readonly DomainOwnership[] => [] }),
  ),
  compositionRoots: Schema.Array(compositionRootSchema).pipe(
    Schema.optionalWith({ default: (): readonly CompositionRoot[] => [] }),
  ),

  packageRuntime: packageRuntimeSchema.pipe(
    Schema.optionalWith({ default: () => "universal" as const }),
  ),

  cacheTtlMs: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(0),
    Schema.optionalWith({ default: () => 5_000 }),
  ),
});

/**
 * Options as a user writes them in an ESLint config, where every threshold
 * and allowance array may be left out.
 */
export type ArchitectureOptionsInput = typeof architectureOptionsSchema.Encoded;

/**
 * Options as the analyzer reads them, with defaults filled in so every
 * threshold has a value and every allowance array is present but possibly
 * empty.
 */
export type ArchitectureOptions = typeof architectureOptionsSchema.Type;

/**
 * Check raw options against the schema without throwing, so the caller
 * decides how an invalid config is reported.
 * @param raw Options object handed over by the ESLint config.
 * @returns The decoded options on the right, or a parse error naming every
 * field that failed on the left.
 */
export function decodeArchitectureOptions(raw: unknown) {
  return Schema.decodeUnknownEither(architectureOptionsSchema)(raw);
}
