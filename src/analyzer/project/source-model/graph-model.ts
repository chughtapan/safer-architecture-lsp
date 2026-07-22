export type ModuleEdgeKind = "import" | "reexport";

export interface LocalModuleEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ModuleEdgeKind;
  readonly typeOnly: boolean;
  readonly specifier: string;
}

export interface ExternalModuleEdge {
  readonly from: string;
  readonly packageName: string;
  readonly kind: ModuleEdgeKind;
  readonly typeOnly: boolean;
  readonly specifier: string;
}

export interface SourceModule {
  readonly fileName: string;
  readonly relativePath: string;
  readonly folder: string;
  readonly topFolder: string;
  readonly isIndex: boolean;
  readonly isPublic: boolean;
  readonly isTestLike: boolean;
  readonly localEdges: readonly LocalModuleEdge[];
  readonly externalEdges: readonly ExternalModuleEdge[];
  readonly exportedSymbols: readonly string[];
  readonly exportedSymbolCount: number;
  readonly localReexportCount: number;
  readonly starExportCount: number;
  readonly topLevelStatementCount: number;
}

export interface ExportConsumer {
  readonly targetFile: string;
  readonly exportName: string;
  readonly consumerFile: string;
  readonly kind: ModuleEdgeKind;
  readonly typeOnly: boolean;
}

export interface FolderEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ModuleEdgeKind;
  readonly files: readonly string[];
}

export interface ProjectArchitectureGraph {
  readonly projectRoot: string;
  readonly reportFile: string;
  readonly modules: readonly SourceModule[];
  readonly modulesByFileName: ReadonlyMap<string, SourceModule>;
  readonly publicModules: readonly SourceModule[];
  readonly localEdges: readonly LocalModuleEdge[];
  readonly externalEdges: readonly ExternalModuleEdge[];
  readonly exportConsumers: readonly ExportConsumer[];
  readonly exportConsumersByFileName: ReadonlyMap<string, readonly ExportConsumer[]>;
  readonly folderEdges: readonly FolderEdge[];
  readonly folders: readonly string[];
  readonly folderLayerIndex: ReadonlyMap<string, number | null>;
}
