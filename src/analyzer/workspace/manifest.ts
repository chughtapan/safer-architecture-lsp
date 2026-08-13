import fs from "node:fs";
import path from "node:path";
import { Either, Schema } from "effect";
import { ArrayFormatter } from "effect/ParseResult";
import { readPackageJson } from "../project/package-json.js";

export const WORKSPACE_FILE_NAME = "safer-architecture.workspace.json";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

class WorkspaceManifest extends Schema.Class<WorkspaceManifest>(
  "WorkspaceManifest",
)({
  packages: Schema.Array(NonEmptyString),
}) {}

export interface WorkspaceProject {
  readonly name: string;
  readonly root: string;
  readonly packageJsonPath: string;
  readonly runtimeDependencies: readonly string[];
}

export interface DiscoveredWorkspace {
  readonly workspaceRoot: string;
  readonly manifestPath: string | null;
  readonly projects: readonly WorkspaceProject[];
}

export type WorkspaceDiscovery =
  | { readonly ok: true; readonly workspace: DiscoveredWorkspace }
  | { readonly ok: false; readonly manifestPath: string; readonly problem: string };

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

  const decoded = Schema.decodeUnknownEither(WorkspaceManifest)(raw);
  if (Either.isLeft(decoded)) {
    const detail = ArrayFormatter.formatErrorSync(decoded.left)
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    return invalid(manifestPath, detail);
  }
  if (decoded.right.packages.length === 0) {
    return invalid(manifestPath, "packages must list at least one package root");
  }

  const projects: WorkspaceProject[] = [];
  const roots = new Set<string>();
  const names = new Set<string>();
  for (const relativeRoot of decoded.right.packages) {
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
    } catch {
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
    if (roots.has(realProjectRoot)) {
      return invalid(manifestPath, `duplicate package root: ${relativeRoot}`);
    }
    const projectRoot = requestedRoot;
    const project = projectAt(projectRoot, true, manifestPath);
    if (!project.ok) return project;
    if (names.has(project.project.name)) {
      return invalid(manifestPath, `duplicate package name: ${project.project.name}`);
    }
    roots.add(realProjectRoot);
    names.add(project.project.name);
    projects.push(project.project);
  }

  projects.sort((left, right) => left.name.localeCompare(right.name));
  return {
    ok: true,
    workspace: { workspaceRoot: root, manifestPath, projects },
  };
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
    : [...new Set([...packageJson.dependencies.keys(), ...packageJson.peerDependencies.keys()])].sort();
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
