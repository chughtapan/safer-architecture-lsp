/**
 * @file Rule-option resolution. Turns whatever an ESLint config supplies
 * into the validated, absolute-path shape the analysis passes read, and
 * rejects domain configurations whose ownership would be ambiguous —
 * duplicate names, overlapping roots, entrypoints outside their own roots.
 */

import { Data, Either } from "effect";
import { ArrayFormatter } from "effect/ParseResult";
import path from "node:path";
import {
  type ArchitectureOptions,
  type CompositionRoot,
  decodeArchitectureOptions,
  type DomainDefinition,
  type DomainOwnership,
} from "./config-schema.js";

// Memoize the schema decode on the raw input reference. ESLint hands the
// same rawOptions object to create() for every (rule × file) in a lint
// pass; without this WeakMap, that's thousands of identical decode
// invocations. We memoize the decoded shape (not the resolved shape) so
// that callers passing a different projectRoot override still pay the
// cheap path.resolve cost but skip the expensive decode.
const decodedCache = new WeakMap<object, ArchitectureOptions>();

interface ArchitectureOptionsIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

class ArchitectureOptionsError extends Data.TaggedError("ArchitectureOptionsError")<{
  readonly message: string;
  readonly issues: readonly ArchitectureOptionsIssue[];
}> {}

/**
 * Options after resolution: `projectRoot` is guaranteed absolute and
 * `tsconfigPath` is either resolved against it or null, so no pass has to
 * re-resolve a path against the process working directory.
 */
export interface ResolvedArchitectureOptions
  extends Omit<ArchitectureOptions, "projectRoot" | "tsconfigPath"> {
  readonly projectRoot: string;
  readonly tsconfigPath: string | null;
}

/**
 * Decode the rule options an ESLint config supplies and resolve their paths
 * against the project root. Throws `ArchitectureOptionsError` listing every
 * offending field when the options fail schema or domain validation, so a
 * misconfiguration surfaces as a message rather than as silent under-analysis.
 * @param raw Options as written in the ESLint config; defaults fill the rest.
 * @param overrideProjectRoot Root that wins over the configured one, for
 * callers that already know which workspace is being analyzed.
 * @returns Options with an absolute project root and a resolved or null
 * tsconfig path.
 */
export function resolveArchitectureOptions(
  raw: unknown = {},
  overrideProjectRoot?: string,
): ResolvedArchitectureOptions {
  const parsed = decodeOrThrow(raw);
  const projectRoot = path.resolve(overrideProjectRoot ?? parsed.projectRoot ?? process.cwd());

  return {
    ...parsed,
    projectRoot,
    tsconfigPath: parsed.tsconfigPath
      ? path.resolve(projectRoot, parsed.tsconfigPath)
      : null,
  };
}

function decodeOrThrow(raw: unknown): ArchitectureOptions {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const cached = decodedCache.get(raw);
    if (cached) {return cached;}
  }

  return Either.match(decodeArchitectureOptions(raw), {
    onLeft: (parseError) => {
      const issues: ArchitectureOptionsIssue[] = ArrayFormatter.formatErrorSync(parseError).map((issue) => ({
        path: issue.path,
        message: issue.message,
      }));
      const summary = issues
        .map((issue) =>
          issue.path.length > 0
            ? `  • ${issue.path.join(".")}: ${issue.message}`
            : `  • ${issue.message}`,
        )
        .join("\n");
      throw new ArchitectureOptionsError({
        message: `Invalid safer-architecture options:\n${summary}`,
        issues,
      });
    },
    onRight: (parsed) => {
      // Validate before caching so a rejected object cannot bypass the
      // semantic checks when the same reference is resolved again.
      validateDomainConfiguration(parsed);
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        decodedCache.set(raw, parsed);
      }
      return parsed;
    },
  });
}

function validateDomainConfiguration(options: ArchitectureOptions): void {
  const names = validateDomainDefinitions(options.domains);
  validateDomainOwnershipPaths(options.domainOwnership, names);
  validateCompositionRootPaths(options.compositionRoots);
  if (options.domains.length === 0 &&
      (options.domainOwnership.length > 0 || options.compositionRoots.length > 0)) {
    domainConfigurationError("domainOwnership and compositionRoots require at least one domain");
  }
}

function validateDomainDefinitions(domains: readonly DomainDefinition[]): ReadonlySet<string> {
  const names = new Set<string>();
  const roots = new Map<string, string>();
  for (const domain of domains) {
    if (names.has(domain.name)) {domainConfigurationError(`duplicate domain name '${domain.name}'`);}
    names.add(domain.name);
    validateDomainRoots(domain, roots);
    validateDomainEntrypoints(domain);
  }
  return names;
}

function validateDomainRoots(domain: DomainDefinition, roots: Map<string, string>): void {
  for (const root of domain.roots) {
    const normalized = validateRelativeArchitecturePath(root, `domain '${domain.name}' root`);
    const existing = roots.get(normalized);
    if (existing !== undefined) {
      domainConfigurationError(`domain root '${root}' is owned by both '${existing}' and '${domain.name}'`);
    }
    roots.set(normalized, domain.name);
  }
}

function validateDomainEntrypoints(domain: DomainDefinition): void {
  const entrypoints = new Set<string>();
  for (const entrypoint of domain.entrypoints) {
    const normalized = validateRelativeArchitecturePath(
      entrypoint,
      `domain '${domain.name}' entrypoint`,
    );
    if (entrypoints.has(normalized)) {
      domainConfigurationError(
        `domain '${domain.name}' has duplicate entrypoint '${entrypoint}'`,
      );
    }
    entrypoints.add(normalized);
    if (!domain.roots.some((root) => pathContains(normalizeConfigPath(root), normalized))) {
      domainConfigurationError(
        `domain '${domain.name}' entrypoint '${entrypoint}' is outside its configured roots`,
      );
    }
  }
}

function validateDomainOwnershipPaths(
  domainOwnership: readonly DomainOwnership[],
  names: ReadonlySet<string>,
): void {
  const ownershipPaths = new Map<string, string>();
  for (const ownership of domainOwnership) {
    const normalized = validateRelativeArchitecturePath(ownership.path, "domain ownership path");
    if (!names.has(ownership.domain)) {
      domainConfigurationError(
        `domain ownership path '${ownership.path}' names unknown domain '${ownership.domain}'`,
      );
    }
    const existing = ownershipPaths.get(normalized);
    if (existing !== undefined) {
      domainConfigurationError(
        `domain ownership path '${ownership.path}' is assigned more than once (${existing}, ${ownership.domain})`,
      );
    }
    ownershipPaths.set(normalized, ownership.domain);
  }
}

function validateCompositionRootPaths(compositionRoots: readonly CompositionRoot[]): void {
  const compositionPaths = new Set<string>();
  for (const composition of compositionRoots) {
    const normalized = validateRelativeArchitecturePath(composition.path, "composition root");
    if (compositionPaths.has(normalized)) {
      domainConfigurationError(`duplicate composition root '${composition.path}'`);
    }
    compositionPaths.add(normalized);
  }
}

function validateRelativeArchitecturePath(value: string, label: string): string {
  const slashPath = value.replaceAll("\\", "/");
  const normalized = normalizeConfigPath(value);
  if (
    path.isAbsolute(value) ||
    slashPath.split("/").includes("..") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    domainConfigurationError(`${label} '${value}' must stay inside the project root`);
  }
  return normalized;
}

function normalizeConfigPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function pathContains(root: string, candidate: string): boolean {
  return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

function domainConfigurationError(message: string): never {
  throw new ArchitectureOptionsError({
    message: `Invalid safer-architecture options:\n  • ${message}`,
    issues: [{ path: ["domains"], message }],
  });
}

/**
 * Forwarded so a consumer can type its ESLint config against the options
 * without reaching past this module into the schema itself.
 */
export type { ArchitectureOptionsInput } from "./config-schema.js";
