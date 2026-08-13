/**
 * @file Module role predicates plus the set arithmetic the cohesion
 * checks run on. Every rule that must skip a facade, a generated file, or
 * a test decides it through these predicates, so "what counts as a
 * facade" is answered in one place rather than per rule.
 */

import type { ResolvedArchitectureOptions } from "../api/index.js";
import type { SourceModule } from "./graph-model.js";
import { normalizePath } from "./source-facts.js";

/**
 * Decide whether a module is a folder's declared entry point. `index.ts`
 * qualifies implicitly; anything else has to be named in the
 * `facadeFiles` option.
 * @param module Module under inspection.
 * @param options Resolved options supplying the configured facade files.
 * @returns True when the module is the sanctioned way into its folder.
 */
export function explicitFacadeModule(
  module: SourceModule,
  options: ResolvedArchitectureOptions,
): boolean {
  return module.isIndex || options.facadeFiles.some((entry) =>
    normalizedFacadeFile(entry.file) === module.relativePath
  );
}

/**
 * Decide whether a module is machine-written. Generated code is exempt
 * from shape rules because nobody edits it to satisfy them.
 * @param module Module under inspection.
 * @returns True when the path sits under a `generated` directory or
 * carries a `.generated` / `.gen` suffix.
 */
export function generatedModule(module: SourceModule): boolean {
  return /(^|\/)(__generated__|generated)(\/|$)/.test(module.relativePath) ||
    /\.(generated|gen)\.[cm]?[tj]sx?$/.test(module.relativePath);
}

/**
 * Narrow a possibly-missing graph lookup to a module that ships. Written
 * as a type guard so callers can pass it straight to `Array.filter` and
 * keep the narrowed element type.
 * @param module Result of a graph lookup, possibly a miss.
 * @returns True when the module exists and is neither test-like nor
 * generated.
 */
export function resolveProductionModule(module: SourceModule | undefined): module is SourceModule {
  return module !== undefined && !module.isTestLike && !generatedModule(module);
}

/**
 * Narrow a graph lookup to a shipped module that is not part of the
 * package's public API — the internals a boundary rule is allowed to
 * reason about.
 * @param module Result of a graph lookup, possibly a miss.
 * @returns True when the module ships and is not a public entry point.
 */
export function resolveImplementationModule(module: SourceModule | undefined): module is SourceModule {
  return resolveProductionModule(module) && !module.isPublic;
}

/**
 * Collapse many sets into one. Used to count the distinct consumers of a
 * module once, rather than once per export they reach it through.
 * @param sets Sets to merge; an empty list yields an empty set.
 * @returns A new set holding every value from every input.
 */
export function unionSets<T>(sets: ReadonlyArray<ReadonlySet<T>>): ReadonlySet<T> {
  const union = new Set<T>();
  for (const set of sets) {
    for (const value of set) {union.add(value);}
  }
  return union;
}

/**
 * Score how much two sets agree, as intersection size over union size.
 * The cohesion check compares the consumer sets of two exports this way:
 * a low score means the exports serve unrelated callers and the module
 * is holding unrelated concerns together.
 * @param left One side of the comparison.
 * @param right The other side of the comparison.
 * @returns A ratio in the range 0 to 1; two empty sets score 0 rather
 * than dividing by zero.
 */
export function jaccardOverlap<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): number {
  const union = unionSets([left, right]);
  if (union.size === 0) {return 0;}
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
    if (right.has(value)) {count += 1;}
  }
  return count;
}
