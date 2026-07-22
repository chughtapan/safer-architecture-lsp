import type {
  FolderEdge,
  ProjectArchitectureGraph,
} from "../project-graph/index.js";
import type { ArchitectureDiagnostic } from "../../project/api/index.js";

interface FolderGraphIndex {
  readonly nodes: ReadonlySet<string>;
  readonly adjacency: ReadonlyMap<string, ReadonlySet<string>>;
}

interface TarjanState {
  index: number;
  readonly adjacency: ReadonlyMap<string, ReadonlySet<string>>;
  readonly stack: string[];
  readonly onStack: Set<string>;
  readonly indices: Map<string, number>;
  readonly lowlinks: Map<string, number>;
  readonly components: string[][];
}

export function stronglyConnectedFolderComponents(
  folderEdges: readonly FolderEdge[],
): readonly (readonly string[])[] {
  const index = folderGraphIndex(folderEdges);
  const state = createTarjanState(index.adjacency);
  for (const node of [...index.nodes].sort()) {
    if (!state.indices.has(node)) connectFolderComponent(state, node);
  }
  return state.components.filter((component) => component.length > 1);
}

export function folderCycleDiagnostics(
  graph: ProjectArchitectureGraph,
  components: readonly (readonly string[])[],
): readonly ArchitectureDiagnostic[] {
  return components.map((component) => ({
    ruleId: "no-folder-cycle",
    file: graph.reportFile,
    severity: "warn",
    message:
      `Folder dependency cycle: ${component.join(" <-> ")}. ` +
      "Folders should expose a stable direction of knowledge; cycles make every " +
      "folder in the component part of the same abstraction.",
  }));
}

export function rootInternalCycleDiagnostics(
  graph: ProjectArchitectureGraph,
  components: readonly (readonly string[])[],
): readonly ArchitectureDiagnostic[] {
  const hasCycle = components.some(
    (component) => component.includes(".") && component.includes("internal"),
  );
  if (!hasCycle) return [];

  return [
    {
      ruleId: "no-root-internal-cycle",
      file: graph.reportFile,
      severity: "error",
      message:
        "Root files and internal files depend on each other. The public/root layer " +
        "should hide internal decisions; internal code should not import back through it.",
    },
  ];
}

function folderGraphIndex(folderEdges: readonly FolderEdge[]): FolderGraphIndex {
  const nodes = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  for (const edge of folderEdges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    const neighbors = adjacency.get(edge.from) ?? new Set<string>();
    neighbors.add(edge.to);
    adjacency.set(edge.from, neighbors);
  }
  return { adjacency, nodes };
}

function createTarjanState(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): TarjanState {
  return {
    index: 0,
    adjacency,
    stack: [],
    onStack: new Set<string>(),
    indices: new Map<string, number>(),
    lowlinks: new Map<string, number>(),
    components: [],
  };
}

function connectFolderComponent(state: TarjanState, node: string): void {
  state.indices.set(node, state.index);
  state.lowlinks.set(node, state.index);
  state.index += 1;
  state.stack.push(node);
  state.onStack.add(node);

  for (const neighbor of state.adjacency.get(node) ?? []) {
    visitFolderNeighbor(state, node, neighbor);
  }
  completeFolderComponent(state, node);
}

function visitFolderNeighbor(
  state: TarjanState,
  node: string,
  neighbor: string,
): void {
  if (!state.indices.has(neighbor)) {
    connectFolderComponent(state, neighbor);
    updateLowlink(state, node, state.lowlinks.get(neighbor) ?? 0);
    return;
  }
  if (state.onStack.has(neighbor)) {
    updateLowlink(state, node, state.indices.get(neighbor) ?? 0);
  }
}

function updateLowlink(state: TarjanState, node: string, candidate: number): void {
  state.lowlinks.set(node, Math.min(state.lowlinks.get(node) ?? 0, candidate));
}

function completeFolderComponent(state: TarjanState, node: string): void {
  if (state.lowlinks.get(node) !== state.indices.get(node)) return;
  state.components.push(popFolderComponent(state, node).sort());
}

function popFolderComponent(state: TarjanState, root: string): string[] {
  const component: string[] = [];
  let next = state.stack.pop() ?? null;
  while (next !== null) {
    state.onStack.delete(next);
    component.push(next);
    if (next === root) return component;
    next = state.stack.pop() ?? null;
  }
  return component;
}
