import path from "node:path";
import ts from "typescript";
import {
  candidateFileNames,
  SOURCE_EXTENSIONS,
} from "../project/api/index.js";

export function resolveLocalSpecifier(
  fromFile: string,
  specifier: string,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
): string | null {
  if (!specifier.startsWith(".")) return null;

  const absolute = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    ...candidateFileNames(absolute),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(absolute, `index${extension}`)),
  ];

  return candidates.find((candidate) => sourceFilesByPath.has(candidate)) ?? null;
}
