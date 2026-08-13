/**
 * @file Shape of the architecture graph. These are the only types the
 * analysis passes read: the import-graph builder produces them once per
 * run and every rule works from that snapshot rather than re-walking the
 * TypeScript AST.
 */

/** Whether an edge came from an `import` or a re-`export` of a module. */
export type ModuleEdgeKind = "import" | "reexport";

/** One dependency on another file inside the project. */
export interface LocalModuleEdge {
  /** Absolute path of the importing file. */
  readonly from: string;
  /** Absolute path of the resolved target file. */
  readonly to: string;
  /** Whether the edge is an import or a re-export. */
  readonly kind: ModuleEdgeKind;
  /** True when the edge carries only types and disappears at runtime. */
  readonly typeOnly: boolean;
  /** Specifier text as written, before resolution. */
  readonly specifier: string;
  /**
   * True when the import binds no names — a bare `import "./x.js"` kept
   * for its side effect. Domain rules exempt these, since they express
   * wiring rather than a dependency on a symbol.
   */
  readonly sideEffectOnly: boolean;
}

/** One dependency on a package outside the project. */
export interface ExternalModuleEdge {
  /** Absolute path of the importing file. */
  readonly from: string;
  /** Package the specifier resolves to, without any subpath. */
  readonly packageName: string;
  /** Whether the edge is an import or a re-export. */
  readonly kind: ModuleEdgeKind;
  /** True when the edge carries only types and disappears at runtime. */
  readonly typeOnly: boolean;
  /** Specifier text as written, before resolution. */
  readonly specifier: string;
}

/**
 * One specifier lookup and its outcome, recorded so a cached report can
 * be replayed without re-running TypeScript's module resolver.
 */
export interface ModuleResolutionSnapshotEntry {
  /** Absolute path of the file the specifier was written in. */
  readonly fromFile: string;
  /** Specifier text as written. */
  readonly specifier: string;
  /** Resolved file, or null for anything outside the project. */
  readonly targetFile: string | null;
}

/** One source file and every fact the architecture rules judge it on. */
export interface SourceModule {
  /** Absolute path of the file. */
  readonly fileName: string;
  /** Path relative to the project root, forward-slashed. */
  readonly relativePath: string;
  /** Folder key relative to `src/`; the root folder is `.`. */
  readonly folder: string;
  /** First segment of `folder`, which layer and kernel rules group on. */
  readonly topFolder: string;
  /** True when the file is named `index`, making it its folder's facade. */
  readonly isIndex: boolean;
  /** True when `package.json` exposes this file as a package entry point. */
  readonly isPublic: boolean;
  /** True when the file belongs to the test tree. */
  readonly isTestLike: boolean;
  /** Edges to other files in this project. */
  readonly localEdges: readonly LocalModuleEdge[];
  /** Edges to packages outside this project. */
  readonly externalEdges: readonly ExternalModuleEdge[];
  /** Exported names, sorted, so comparisons do not depend on file order. */
  readonly exportedSymbols: readonly string[];
  /** Size of the module's public surface. */
  readonly exportedSymbolCount: number;
  /** Local edges that re-export rather than import — facade width. */
  readonly localReexportCount: number;
  /** Count of `export * from` declarations, which widen the surface unnamed. */
  readonly starExportCount: number;
  /** Statements excluding imports — how much the file actually does. */
  readonly topLevelStatementCount: number;
}

/**
 * One consumer reaching one exported name. The reverse of an import
 * edge, resolved down to the individual symbol so cohesion checks can
 * ask which callers share which exports.
 */
export interface ExportConsumer {
  /** Absolute path of the file that owns the export. */
  readonly targetFile: string;
  /** Exported name being consumed. */
  readonly exportName: string;
  /** Absolute path of the file consuming it. */
  readonly consumerFile: string;
  /** Whether the consumer imports or re-exports the name. */
  readonly kind: ModuleEdgeKind;
  /** True when the consumer takes the name as a type only. */
  readonly typeOnly: boolean;
}

/**
 * Local edges collapsed to the folder level, which is the granularity
 * cycle and layering rules reason at. Edges within one folder, and
 * between a folder and its own nested folders, are left out.
 */
export interface FolderEdge {
  /** Folder key the dependency starts from. */
  readonly from: string;
  /** Folder key the dependency points at. */
  readonly to: string;
  /** Whether the underlying file edges import or re-export. */
  readonly kind: ModuleEdgeKind;
  /** Sorted files behind this folder edge, for pointing a diagnostic at one. */
  readonly files: readonly string[];
}

/**
 * Everything one analysis run knows about a project. Built once and
 * passed to every pass; the pre-built maps and folder indexes exist so
 * passes look up rather than rescan.
 */
export interface ProjectArchitectureGraph {
  /** Absolute project root the graph was built for. */
  readonly projectRoot: string;
  /** File project-wide findings are attached to, usually the entry point. */
  readonly reportFile: string;
  /** Every project source file, in resolution order. */
  readonly modules: readonly SourceModule[];
  /** `modules` keyed by absolute path for O(1) edge-endpoint lookup. */
  readonly modulesByFileName: ReadonlyMap<string, SourceModule>;
  /** The subset of `modules` `package.json` exposes. */
  readonly publicModules: readonly SourceModule[];
  /** Every in-project edge, flattened across modules. */
  readonly localEdges: readonly LocalModuleEdge[];
  /** Every out-of-project edge, flattened across modules. */
  readonly externalEdges: readonly ExternalModuleEdge[];
  /** Specifier lookups recorded during the build, for the cache watermark. */
  readonly moduleResolutions: readonly ModuleResolutionSnapshotEntry[];
  /** Symbol-level reverse edges, sorted for stable diagnostic order. */
  readonly exportConsumers: readonly ExportConsumer[];
  /** `exportConsumers` grouped by the file that owns the export. */
  readonly exportConsumersByFileName: ReadonlyMap<string, readonly ExportConsumer[]>;
  /** Cross-folder dependencies, sorted. */
  readonly folderEdges: readonly FolderEdge[];
  /** Every folder key in the project, sorted. */
  readonly folders: readonly string[];
  /**
   * Position of each folder in the configured layer order, or null when
   * no layer claims it. Direction rules compare these indexes, so an
   * unclaimed folder is skipped rather than assumed to sit anywhere.
   */
  readonly folderLayerIndex: ReadonlyMap<string, number | null>;
}
