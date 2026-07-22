/**
 * @file Architecture diagnostic core types. Defines the shared
 * diagnostic, report, package-json, and package-export shapes that
 * every analysis pass returns, plus the deduplication helper.
 */

import type { ArchitectureRuleId } from "../../rule-ids.js";

/** Severity reported by an architecture diagnostic. */
export type ArchitectureSeverity = "error" | "warn";

export type {
  LayerDefinition,
} from "../config-schema.js";

export type { ArchitectureDiagnosticRuleId } from "../../rule-ids.js";
export type { ResolvedArchitectureOptions } from "../config.js";

/** A single architecture finding pointed at one file. */
export interface ArchitectureDiagnostic {
  /** Architecture rule id (matches the ESLint rule id). */
  readonly ruleId: ArchitectureRuleId;
  /** Absolute path of the file the finding is attached to. */
  readonly file: string;
  /** Severity reported on the finding. */
  readonly severity: ArchitectureSeverity;
  /** Human-readable message describing the finding. */
  readonly message: string;
}

/** Result of a full architecture analysis run. */
export interface ArchitectureReport {
  /** Deduplicated diagnostics produced by every analysis pass. */
  readonly diagnostics: readonly ArchitectureDiagnostic[];

  /**
   * Diagnostics grouped by absolute file path so the per-file ESLint
   * rule listener can look up its findings in O(1) instead of scanning
   * the whole array on every `(file × rule)` invocation. Files with no
   * findings are absent from the map.
   */
  readonly diagnosticsByFile: ReadonlyMap<string, readonly ArchitectureDiagnostic[]>;
}

/** Parsed shape of the analyzer's view of `package.json`. */
export interface PackageJson {
  /** Package name from `package.json`. */
  readonly name?: string;
  /** Legacy `main` entry path. */
  readonly main?: string;
  /** Legacy `types` entry path. */
  readonly types?: string;
  /** Modern `exports` map (left as raw JSON for downstream walking). */
  readonly exports?: unknown;
  /** Runtime dependencies keyed by package name. */
  readonly dependencies: ReadonlyMap<string, string>;
  /** Dev-only dependencies keyed by package name. */
  readonly devDependencies: ReadonlyMap<string, string>;
  /** Peer dependencies keyed by package name. */
  readonly peerDependencies: ReadonlyMap<string, string>;
}

/** One flat entry from a package's `exports` / `main` / `types` map. */
export interface PackageExportEntry {
  /** Public subpath under the package (e.g. `.`, `./foo`). */
  readonly publicPath: string;
  /** Target path the public subpath resolves to. */
  readonly targetPath: string;
}

/**
 * Drop duplicate diagnostics whose `(ruleId, file, message)` triple
 * already appeared. Preserves first-seen order.
 * @param diagnostics Diagnostics from one or more analysis passes.
 * @returns Deduplicated diagnostics in original encounter order.
 */
export function uniqueDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
): readonly ArchitectureDiagnostic[] {
  const seen = new Set<string>();
  const unique: ArchitectureDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.ruleId}\0${diagnostic.file}\0${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
}
