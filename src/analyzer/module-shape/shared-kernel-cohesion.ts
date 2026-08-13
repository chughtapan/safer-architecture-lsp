/**
 * @file Detection of low-cohesion shared kernels: wide modules whose exports
 * serve mostly disjoint groups of consumers. Cohesion is scored as the median
 * Jaccard overlap over every pair of exports rather than an average, so one
 * universally imported symbol cannot mask a grab bag of unrelated ones.
 */

import type {
  ExportConsumer,
  ProjectArchitectureGraph,
  SourceModule,
} from "../imports/index.js";
import type { ArchitectureDiagnostic, ResolvedArchitectureOptions } from "../project/api/index.js";
import {
  explicitFacadeModule,
  generatedModule,
  jaccardOverlap,
  resolveProductionModule,
  unionSets,
} from "../project/index.js";

interface ExportConsumerSets {
  readonly consumedExports: readonly string[];
  readonly consumersByExport: ReadonlyMap<string, ReadonlySet<string>>;
  readonly totalConsumers: ReadonlySet<string>;
}

interface ExportOverlap {
  readonly primaryExport: string;
  readonly secondaryExport: string;
  readonly score: number;
}

interface OverlapStats {
  readonly medianScore: number;
  readonly comparisonCount: number;
  readonly samples: readonly string[];
}

/**
 * Report modules that many production files import for unrelated reasons.
 * Only exports with production consumers are scored, and a module must clear
 * both the export and consumer minimums before overlap is measured at all,
 * so a small helper is never judged on two data points.
 * @param graph Supplies the module list and the per-export consumer records
 * the overlap score is computed from.
 * @param options Minimum exports and consumers required before a module is
 * scored, and the median overlap below which it is reported.
 * @returns One warning per low-cohesion module, naming its least-overlapping
 * export pairs; empty when every wide module's exports travel together.
 */
export function sharedKernelCohesionDiagnostics(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
): readonly ArchitectureDiagnostic[] {
  return graph.modules.flatMap((module) =>
    sharedKernelCohesionDiagnostic(graph, options, module)
  );
}

function sharedKernelCohesionDiagnostic(
  graph: ProjectArchitectureGraph,
  options: ResolvedArchitectureOptions,
  module: SourceModule,
): readonly ArchitectureDiagnostic[] {
  if (!sharedKernelCandidate(module, options)) {return [];}
  const consumerSets = productionConsumerSets(graph, module);
  if (!enoughSharedKernelEvidence(consumerSets, options)) {return [];}
  const overlap = summarizeExportOverlap(consumerSets);
  if (overlap === null || overlap.medianScore >= options.maxSharedKernelMedianOverlap) {
    return [];
  }
  return [lowCohesionDiagnostic(module, consumerSets, overlap)];
}

function sharedKernelCandidate(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  return !explicitFacadeModule(module, options) && !module.isTestLike && !generatedModule(module);
}

function enoughSharedKernelEvidence(
  consumerSets: ExportConsumerSets,
  options: ResolvedArchitectureOptions,
): boolean {
  return consumerSets.consumedExports.length >= options.minSharedKernelExports &&
    consumerSets.totalConsumers.size >= options.minSharedKernelConsumers;
}

function productionConsumerSets(
  graph: ProjectArchitectureGraph,
  module: SourceModule,
): ExportConsumerSets {
  const consumersByExport = new Map<string, Set<string>>();
  for (const consumer of graph.exportConsumersByFileName.get(module.fileName) ?? []) {
    addProductionExportConsumer(consumersByExport, graph, consumer);
  }
  const consumedExports = [...consumersByExport.keys()].sort(compareStrings);
  return {
    consumedExports,
    consumersByExport,
    totalConsumers: unionSets([...consumersByExport.values()]),
  };
}

function addProductionExportConsumer(
  consumersByExport: Map<string, Set<string>>,
  graph: ProjectArchitectureGraph,
  consumer: ExportConsumer,
): void {
  const consumerModule = graph.modulesByFileName.get(consumer.consumerFile);
  if (!resolveProductionModule(consumerModule)) {return;}
  const consumers = consumersByExport.get(consumer.exportName) ?? new Set<string>();
  consumers.add(consumer.consumerFile);
  consumersByExport.set(consumer.exportName, consumers);
}

function summarizeExportOverlap(
  consumerSets: ExportConsumerSets,
): OverlapStats | null {
  const overlaps = exportPairOverlaps(consumerSets);
  if (overlaps.length === 0) {return null;}
  const sorted = [...overlaps].sort((first, second) => first.score - second.score);
  return {
    medianScore: sorted[Math.floor(sorted.length / 2)]?.score ?? 0,
    comparisonCount: sorted.length,
    samples: sorted.slice(0, 3).map(overlapSample),
  };
}

function exportPairOverlaps(consumerSets: ExportConsumerSets): readonly ExportOverlap[] {
  const pairs: ExportOverlap[] = [];
  const names = consumerSets.consumedExports;
  for (let firstIndex = 0; firstIndex < names.length; firstIndex += 1) {
    addExportPairOverlaps(pairs, consumerSets, names, firstIndex);
  }
  return pairs;
}

function addExportPairOverlaps(
  pairs: ExportOverlap[],
  consumerSets: ExportConsumerSets,
  names: readonly string[],
  firstIndex: number,
): void {
  for (let secondIndex = firstIndex + 1; secondIndex < names.length; secondIndex += 1) {
    const primaryExport = names[firstIndex];
    const secondaryExport = names[secondIndex];
    if (primaryExport !== undefined && secondaryExport !== undefined) {
      pairs.push(exportPairOverlap(consumerSets, primaryExport, secondaryExport));
    }
  }
}

function exportPairOverlap(
  consumerSets: ExportConsumerSets,
  primaryExport: string,
  secondaryExport: string,
): ExportOverlap {
  return {
    primaryExport,
    secondaryExport,
    score: jaccardOverlap(
      consumerSets.consumersByExport.get(primaryExport) ?? new Set(),
      consumerSets.consumersByExport.get(secondaryExport) ?? new Set(),
    ),
  };
}

function overlapSample(overlap: ExportOverlap): string {
  return `${overlap.primaryExport}/${overlap.secondaryExport}`;
}

function lowCohesionDiagnostic(
  module: SourceModule,
  consumerSets: ExportConsumerSets,
  overlap: OverlapStats,
): ArchitectureDiagnostic {
  return {
    ruleId: "shared-kernel-cohesion",
    file: module.fileName,
    severity: "warn",
    message:
      `${module.relativePath} has ${consumerSets.consumedExports.length} production ` +
      `exports but low consumer overlap across export families ` +
      `(median ${overlap.medianScore.toFixed(2)} across ` +
      `${overlap.comparisonCount} pairs). ${overlap.samples.join(", ")} are ` +
      "used by mostly different modules. Split cohesive helper modules or expose a small facade.",
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
