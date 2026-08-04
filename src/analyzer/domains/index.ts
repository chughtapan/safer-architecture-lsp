import path from "node:path";
import { makeDirectedGraph } from "../graph/directed-graph.js";
import {
  canonicalCyclePath,
  cyclicStronglyConnectedComponents,
} from "../graph/strongly-connected-components.js";
import type { ProjectArchitectureGraph, SourceModule } from "../project/index.js";
import type {
  ArchitectureDiagnostic,
  DomainDefinition,
  ResolvedArchitectureOptions,
} from "../project/api/index.js";

type ModuleOwner =
  | { readonly kind: "domain"; readonly domain: DomainDefinition }
  | { readonly kind: "composition" }
  | { readonly kind: "unowned" };

interface DomainEdge {
  readonly from: string;
  readonly to: string;
  readonly source: SourceModule;
}

export function domainArchitectureDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  if (options.domains.length === 0) return [];
  const owners = new Map(
    graph.modules.map((module) => [module.fileName, ownerOf(module, options)] as const),
  );
  const unowned = graph.modules
    .filter((module) => !module.isTestLike && owners.get(module.fileName)?.kind === "unowned")
    .map(unownedDiagnostic);
  const domainEdges: DomainEdge[] = [];
  const bypasses: ArchitectureDiagnostic[] = [];
  const sideEffects: ArchitectureDiagnostic[] = [];

  for (const edge of graph.localEdges) {
    const source = graph.modulesByFileName.get(edge.from);
    const target = graph.modulesByFileName.get(edge.to);
    if (source === undefined || target === undefined || source.isTestLike || target.isTestLike) continue;
    const from = owners.get(source.fileName);
    const to = owners.get(target.fileName);
    if (from?.kind !== "domain" || to?.kind !== "domain" || from.domain.name === to.domain.name) {
      continue;
    }
    domainEdges.push({ from: from.domain.name, to: to.domain.name, source });
    if (!isDomainEntrypoint(target.relativePath, to.domain)) {
      bypasses.push({
        ruleId: "no-domain-boundary-bypass",
        file: source.fileName,
        severity: "error",
        message: `${source.relativePath} (${from.domain.name}) imports ${target.relativePath} inside domain '${to.domain.name}', bypassing its configured entrypoints (${to.domain.entrypoints.join(", ")}). Import the domain boundary instead.`,
      });
    }
    if (edge.sideEffectOnly) {
      sideEffects.push({
        ruleId: "no-cross-domain-side-effect",
        file: source.fileName,
        severity: "error",
        message: `${source.relativePath} performs a side-effect-only import of ${target.relativePath} across domains (${from.domain.name} -> ${to.domain.name}). Move cross-domain wiring into a configured composition root.`,
      });
    }
  }

  return [...unowned, ...domainCycleDiagnostics(graph, options, domainEdges), ...bypasses, ...sideEffects];
}

function ownerOf(module: SourceModule, options: ResolvedArchitectureOptions): ModuleOwner {
  if (matchesAny(module.relativePath, options.compositionRoots.map(({ path }) => path))) {
    return { kind: "composition" };
  }
  const explicit = [...options.domainOwnership]
    .sort((left, right) => right.path.length - left.path.length)
    .find(({ path }) => pathContains(normalize(path), module.relativePath));
  if (explicit !== undefined) {
    const domain = options.domains.find(({ name }) => name === explicit.domain);
    if (domain !== undefined) return { kind: "domain", domain };
  }
  const domain = options.domains
    .flatMap((candidate) => candidate.roots.map((root) => ({ candidate, root: normalize(root) })))
    .sort((left, right) => right.root.length - left.root.length)
    .find(({ root }) => pathContains(root, module.relativePath))?.candidate;
  return domain === undefined ? { kind: "unowned" } : { kind: "domain", domain };
}

function unownedDiagnostic(module: SourceModule): ArchitectureDiagnostic {
  return {
    ruleId: "require-domain-ownership",
    file: module.fileName,
    severity: "error",
    message: `${module.relativePath} is production code outside every configured domain and composition root. Add a domain root, an explicit domainOwnership entry, or a reason-carrying compositionRoot.`,
  };
}

function domainCycleDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  edges: readonly DomainEdge[],
): readonly ArchitectureDiagnostic[] {
  const directed = makeDirectedGraph(options.domains.map(({ name }) => name), edges);
  return cyclicStronglyConnectedComponents(directed).map((component) => {
    const cycle = canonicalCyclePath(directed, component);
    const anchor = edges
      .filter((edge) => component.includes(edge.from) && component.includes(edge.to))
      .sort((left, right) => left.source.fileName.localeCompare(right.source.fileName))[0];
    return {
      ruleId: "no-domain-cycle",
      file: anchor?.source.fileName ?? graph.reportFile,
      severity: "error",
      message: `Domain dependency cycle: ${component.join(" <-> ")}. Canonical cycle: ${cycle.join(" -> ")}. Domain dependencies must remain acyclic.`,
    };
  });
}

function isDomainEntrypoint(relativePath: string, domain: DomainDefinition): boolean {
  return matchesAny(relativePath, domain.entrypoints);
}

function matchesAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathContains(normalize(root), candidate));
}

function pathContains(root: string, candidate: string): boolean {
  const normalizedCandidate = normalize(candidate);
  return root === "." || normalizedCandidate === root || normalizedCandidate.startsWith(`${root}/`);
}

function normalize(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}
