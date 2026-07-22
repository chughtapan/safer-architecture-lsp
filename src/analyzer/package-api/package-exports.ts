import { collectPackageExportEntries, stripKnownExtension } from "../project/api/index.js";
import type {
  ResolvedArchitectureOptions,
  PackageExportEntry,
  PackageJson,
  ArchitectureDiagnostic,
} from "../project/api/index.js";

export function checkPackageExports(
  packageJson: PackageJson,
  options: ResolvedArchitectureOptions,
  reportFile: string,
): readonly ArchitectureDiagnostic[] {
  const entries = collectPackageExportEntries(packageJson);
  return [
    ...internalSubpathDiagnostics(entries, options, reportFile),
    ...subpathBudgetDiagnostics(entries, options, reportFile),
    ...wildcardExportDiagnostics(entries, options, reportFile),
    ...testHelperExportDiagnostics(entries, options, reportFile),
    ...implementationFilePublicEntryDiagnostics(entries, options, reportFile),
  ];
}

function pathHasForbiddenSegment(
  pathLike: string,
  forbiddenSegments: readonly string[],
): boolean {
  const forbidden = new Set(forbiddenSegments);
  return packagePathSegments(pathLike).some((segment) =>
    forbidden.has(segment),
  );
}

function packagePathSegments(pathLike: string): readonly string[] {
  return pathLike
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => stripKnownExtension(segment.replace(/^\.+/, "").replaceAll("*", "")))
    .filter((segment) => segment.length > 0);
}

function internalSubpathDiagnostics(
  entries: readonly PackageExportEntry[],
  options: ResolvedArchitectureOptions,
  reportFile: string,
): readonly ArchitectureDiagnostic[] {
  return entries.flatMap((entry) => {
    if (options.allowedPublicSubpaths.some((s) => s.subpath === entry.publicPath)) return [];

    const exposesInternalPath =
      pathHasForbiddenSegment(entry.publicPath, options.forbiddenSubpathSegments) ||
      pathHasForbiddenSegment(entry.targetPath, options.forbiddenSubpathSegments);
    if (!exposesInternalPath) return [];

    return [
      {
        ruleId: "no-internal-subpath-export",
        file: reportFile,
        severity: "error",
        message:
          `package.json export "${entry.publicPath}" exposes implementation path ` +
          `"${entry.targetPath}". Public exports should be curated entrypoints, ` +
          "not src/internal/utils/helpers.",
      },
    ];
  });
}

function subpathBudgetDiagnostics(
  entries: readonly PackageExportEntry[],
  options: ResolvedArchitectureOptions,
  reportFile: string,
): readonly ArchitectureDiagnostic[] {
  const uniqueSubpaths = new Set(
    entries.map((entry) => entry.publicPath).filter((key) => key !== "."),
  );
  if (uniqueSubpaths.size <= options.maxSubpathExports) return [];

  return [
    {
      ruleId: "no-internal-subpath-export",
      file: reportFile,
      severity: "warn",
      message:
        `package.json exposes ${uniqueSubpaths.size} public subpaths. ` +
        `The default budget is ${options.maxSubpathExports}; a growing subpath list ` +
        "turns the filesystem into public API.",
    },
  ];
}

function wildcardExportDiagnostics(
  entries: readonly PackageExportEntry[],
  options: ResolvedArchitectureOptions,
  reportFile: string,
): readonly ArchitectureDiagnostic[] {
  const wildcardEntries = entries.filter((entry) => entry.publicPath.includes("*"));
  if (wildcardEntries.length <= options.maxWildcardExports) return [];

  return wildcardEntries.map((entry) => ({
    ruleId: "no-internal-subpath-export",
    file: reportFile,
    severity: "error",
    message:
      `package.json export "${entry.publicPath}" is a wildcard public surface. ` +
      "Wildcard exports make implementation files importable by consumers.",
  }));
}

function testHelperExportDiagnostics(
  entries: readonly PackageExportEntry[],
  options: ResolvedArchitectureOptions,
  reportFile: string,
): readonly ArchitectureDiagnostic[] {
  return entries.flatMap((entry) => {
    if (options.allowedTestPublicSubpaths.some((s) => s.subpath === entry.publicPath)) return [];

    const exposesTestShape =
      pathHasForbiddenSegment(entry.publicPath, testOnlySegments) ||
      pathHasForbiddenSegment(entry.targetPath, testOnlySegments);
    if (!exposesTestShape) return [];

    return [
      {
        ruleId: "no-public-test-helper-leak",
        file: reportFile,
        severity: "warn",
        message:
          `package.json export "${entry.publicPath}" exposes test-only path ` +
          `"${entry.targetPath}". Test helpers need an explicitly allowed testing ` +
          "subpath so consumers do not treat them as production API.",
      },
    ];
  });
}

function implementationFilePublicEntryDiagnostics(
  entries: readonly PackageExportEntry[],
  options: ResolvedArchitectureOptions,
  reportFile: string,
): readonly ArchitectureDiagnostic[] {
  return entries.flatMap((entry) => {
    if (options.allowedPublicSubpaths.some((s) => s.subpath === entry.publicPath)) return [];

    const exposesImplementation =
      pathHasForbiddenSegment(entry.publicPath, options.implementationPathSegments) ||
      pathHasForbiddenSegment(entry.targetPath, options.implementationPathSegments);
    if (!exposesImplementation) return [];

    return [
      {
        ruleId: "no-implementation-file-public-entry",
        file: reportFile,
        severity: "warn",
        message:
          `package.json export "${entry.publicPath}" points at implementation-shaped ` +
          `path "${entry.targetPath}". Public entrypoints should be named for the ` +
          "contract they provide, not the concrete file or pattern behind it.",
      },
    ];
  });
}

const testOnlySegments = [
  "test",
  "tests",
  "testing",
  "test-utils",
  "test-support",
  "fixtures",
  "__fixtures__",
  "__tests__",
];
