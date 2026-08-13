/**
 * @file Workspace manifest reading. Turns a repository root into the packages
 * the analyzer should treat as one workspace, refusing any manifest that would
 * point analysis at a directory outside that root or at the same package twice.
 */

import { Either, Schema } from "effect";
import { ArrayFormatter, type ParseError } from "effect/ParseResult";
import fs from "node:fs";
import path from "node:path";
import { readPackageJson } from "../project/package-json.js";

/** Manifest filename whose presence in a root makes it a multi-package workspace. */
export const WORKSPACE_FILE_NAME = "safer-architecture.workspace.json";

const nonEmptyString = Schema.String.pipe(Schema.minLength(1));

class WorkspaceManifest extends Schema.Class<WorkspaceManifest>(
  "WorkspaceManifest",
)({
  packages: Schema.Array(nonEmptyString),
}) {}

/**
 * One package of a workspace. The name is the package.json name, falling back
 * to the directory name; runtime dependencies merge `dependencies` and
 * `peerDependencies` and are sorted so downstream graphs stay reproducible.
 */
export interface WorkspaceProject {
  readonly name: string;
  readonly root: string;
  readonly packageJsonPath: string;
  readonly runtimeDependencies: readonly string[];
}

/**
 * The packages a workspace root resolved to, in name order. A null manifest
 * path means no manifest was found and the root is its own single package,
 * which is how cross-package checks tell the two shapes apart.
 */
export interface DiscoveredWorkspace {
  readonly workspaceRoot: string;
  readonly manifestPath: string | null;
  readonly projects: readonly WorkspaceProject[];
}

/**
 * Outcome of reading a workspace root: the resolved packages, or the manifest
 * that was rejected together with the reason, so callers can surface the
 * problem against the manifest instead of analyzing a partial workspace.
 */
export type WorkspaceDiscovery =
  | { readonly ok: true; readonly workspace: DiscoveredWorkspace }
  | { readonly ok: false; readonly manifestPath: string; readonly problem: string };

/**
 * Expand a repository root into the packages the analyzer treats as one
 * workspace; with no manifest present the root itself is the only package.
 * Package roots that are absolute, escape the root (directly or through a
 * symlink), duplicate another root or name, or are not directories are
 * rejected rather than analyzed.
 * @param workspaceRoot Directory searched for the manifest, and the base the
 * manifest's relative package roots resolve against.
 * @returns The packages sorted by name, or the manifest path and the reason it
 * was refused.
 */
export function discoverWorkspace(workspaceRoot: string): WorkspaceDiscovery {
  const root = path.resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch (error) {
    return invalid(
      path.join(root, WORKSPACE_FILE_NAME),
      `workspace root cannot be resolved: ${errorMessage(error)}`,
    );
  }
  const manifestPath = path.join(root, WORKSPACE_FILE_NAME);
  if (!fs.existsSync(manifestPath)) {
    return singleProjectWorkspace(root)(projectAt(root, false, manifestPath));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return invalid(manifestPath, `invalid JSON: ${errorMessage(error)}`);
  }

  return Either.match(Schema.decodeUnknownEither(WorkspaceManifest)(raw), {
    onLeft: (parseError) => invalid(manifestPath, decodeProblem(parseError)),
    onRight: (manifest) =>
      manifestWorkspace({ root, canonicalRoot, manifestPath }, manifest.packages),
  });
}

/** The three root paths every manifest package root is judged against. */
interface WorkspaceRoots {
  readonly root: string;
  readonly canonicalRoot: string;
  readonly manifestPath: string;
}

function decodeProblem(parseError: ParseError): string {
  return ArrayFormatter.formatErrorSync(parseError)
    .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
    .join("; ");
}

function manifestWorkspace(
  roots: WorkspaceRoots,
  packages: readonly string[],
): WorkspaceDiscovery {
  if (packages.length === 0) {
    return invalid(roots.manifestPath, "packages must list at least one package root");
  }

  const projects: WorkspaceProject[] = [];
  const seenRoots = new Set<string>();
  const seenNames = new Set<string>();
  for (const relativeRoot of packages) {
    const resolved = manifestPackage(roots, relativeRoot, seenRoots, seenNames);
    if (!resolved.ok) {return resolved;}
    projects.push(resolved.project);
  }

  projects.sort((left, right) => left.name.localeCompare(right.name));
  return {
    ok: true,
    workspace: {
      workspaceRoot: roots.root,
      manifestPath: roots.manifestPath,
      projects,
    },
  };
}

function manifestPackage(
  roots: WorkspaceRoots,
  relativeRoot: string,
  seenRoots: Set<string>,
  seenNames: Set<string>,
): ProjectResult {
  const { root, canonicalRoot, manifestPath } = roots;
  if (path.isAbsolute(relativeRoot)) {
    return invalid(manifestPath, `package root must be relative: ${relativeRoot}`);
  }
  const requestedRoot = path.resolve(root, relativeRoot);
  const relative = path.relative(root, requestedRoot);
  if (relative.startsWith(`..${path.sep}`) || relative === "..") {
    return invalid(manifestPath, `package root escapes the workspace: ${relativeRoot}`);
  }
  try {
    if (!fs.statSync(requestedRoot).isDirectory()) {
      return invalid(manifestPath, `package root is not a directory: ${requestedRoot}`);
    }
  } catch (error) {
    discardStatError(error);
    return invalid(manifestPath, `package root is not a directory: ${requestedRoot}`);
  }
  let realProjectRoot: string;
  try {
    realProjectRoot = fs.realpathSync(requestedRoot);
  } catch (error) {
    return invalid(
      manifestPath,
      `package root cannot be resolved: ${relativeRoot}: ${errorMessage(error)}`,
    );
  }
  const canonicalRelative = path.relative(canonicalRoot, realProjectRoot);
  if (canonicalRelative.startsWith(`..${path.sep}`) || canonicalRelative === "..") {
    return invalid(manifestPath, `package root escapes the workspace through a symlink: ${relativeRoot}`);
  }
  if (seenRoots.has(realProjectRoot)) {
    return invalid(manifestPath, `duplicate package root: ${relativeRoot}`);
  }
  const projectRoot = requestedRoot;
  const project = projectAt(projectRoot, true, manifestPath);
  if (!project.ok) {return project;}
  if (seenNames.has(project.project.name)) {
    return invalid(manifestPath, `duplicate package name: ${project.project.name}`);
  }
  seenRoots.add(realProjectRoot);
  seenNames.add(project.project.name);
  return project;
}

// A stat failure and a non-directory are the same rejection here: either way
// the package root is unusable and the message is identical, so the caught
// error carries no extra signal. Callers bind it and hand it here, so the
// overload accepts it and the implementation drops it.
function discardStatError(captured: unknown): null;
function discardStatError(): null {
  return null;
}

type ProjectResult =
  | { readonly ok: true; readonly project: WorkspaceProject }
  | { readonly ok: false; readonly manifestPath: string; readonly problem: string };

function projectAt(
  projectRoot: string,
  requirePackageName: boolean,
  manifestPath: string,
): ProjectResult {
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return invalid(manifestPath, `package root is not a directory: ${projectRoot}`);
  }
  let packageJson: ReturnType<typeof readPackageJson>;
  try {
    packageJson = readPackageJson(projectRoot);
  } catch (error) {
    return invalid(manifestPath, `invalid package.json at ${projectRoot}: ${errorMessage(error)}`);
  }
  if (requirePackageName && (packageJson?.name === undefined || packageJson.name.trim().length === 0)) {
    return invalid(manifestPath, `package.json at ${projectRoot} must have a non-empty name`);
  }
  const runtimeDependencies = packageJson === null
    ? []
    : [...new Set([...packageJson.dependencies.keys(), ...packageJson.peerDependencies.keys()])]
        .sort(compareStrings);
  return {
    ok: true,
    project: {
      name: packageJson?.name ?? path.basename(projectRoot),
      root: projectRoot,
      packageJsonPath: path.join(projectRoot, "package.json"),
      runtimeDependencies,
    },
  };
}

function singleProjectWorkspace(root: string) {
  return (result: ProjectResult): WorkspaceDiscovery => result.ok
    ? {
        ok: true,
        workspace: { workspaceRoot: root, manifestPath: null, projects: [result.project] },
      }
    : result;
}

function invalid(manifestPath: string, problem: string): WorkspaceDiscovery & ProjectResult {
  return { ok: false, manifestPath, problem };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
