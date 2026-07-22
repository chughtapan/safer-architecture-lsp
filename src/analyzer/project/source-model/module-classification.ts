import { normalizePath } from "./source-facts.js";
import type { ResolvedArchitectureOptions } from "../api/index.js";
import type { SourceModule } from "./graph-model.js";

export function explicitFacadeModule(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  return module.isIndex || options.facadeFiles.some((entry) =>
    normalizedFacadeFile(entry.file) === module.relativePath
  );
}

export function generatedModule(module: SourceModule): boolean {
  return /(^|\/)(__generated__|generated)(\/|$)/.test(module.relativePath) ||
    /\.(generated|gen)\.[cm]?[tj]sx?$/.test(module.relativePath);
}

export function resolveProductionModule(module: SourceModule | undefined): module is SourceModule {
  return module !== undefined && !module.isTestLike && !generatedModule(module);
}

export function resolveImplementationModule(module: SourceModule | undefined): module is SourceModule {
  return resolveProductionModule(module) && !module.isPublic;
}

export function unionSets<T>(sets: readonly ReadonlySet<T>[]): ReadonlySet<T> {
  const union = new Set<T>();
  for (const set of sets) {
    for (const value of set) union.add(value);
  }
  return union;
}

export function jaccardOverlap<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): number {
  const union = unionSets([left, right]);
  if (union.size === 0) return 0;
  return setIntersectionSize(left, right) / union.size;
}

function normalizedFacadeFile(file: string): string {
  const withoutDot = normalizePath(file).replace(/^\.\//, "");
  return withoutDot.startsWith("src/") ? withoutDot : `src/${withoutDot}`;
}

function setIntersectionSize<T>(
  left: ReadonlySet<T>,
  right: ReadonlySet<T>,
): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}
