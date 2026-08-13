/**
 * @file Workspace analysis barrel. Public surface for expanding a repository
 * root into the set of packages the analyzer treats as one workspace, and for
 * the cross-package check that spans them.
 */

/** Manifest discovery and the package set a workspace root expands to. */
export {
  type DiscoveredWorkspace,
  discoverWorkspace,
  WORKSPACE_FILE_NAME,
  type WorkspaceProject,
} from "./manifest.js";
/** Cycle detection over runtime dependencies between workspace packages. */
export { workspacePackageCycleDiagnostics } from "./package-cycles.js";
