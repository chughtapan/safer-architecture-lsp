import path from "node:path";
import { Data, Either } from "effect";
import { ArrayFormatter } from "effect/ParseResult";
import {
  decodeArchitectureOptions,
  type ArchitectureOptions,
} from "./config-schema.js";

// Memoize the schema decode on the raw input reference. ESLint hands the
// same rawOptions object to create() for every (rule × file) in a lint
// pass; without this WeakMap, that's thousands of identical decode
// invocations. We memoize the decoded shape (not the resolved shape) so
// that callers passing a different projectRoot override still pay the
// cheap path.resolve cost but skip the expensive decode.
const decodedCache = new WeakMap<object, ArchitectureOptions>();

interface ArchitectureOptionsIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

class ArchitectureOptionsError extends Data.TaggedError("ArchitectureOptionsError")<{
  readonly message: string;
  readonly issues: ReadonlyArray<ArchitectureOptionsIssue>;
}> {}

// projectRoot is guaranteed absolute, tsconfigPath either resolved or null.
export interface ResolvedArchitectureOptions
  extends Omit<ArchitectureOptions, "projectRoot" | "tsconfigPath"> {
  readonly projectRoot: string;
  readonly tsconfigPath: string | null;
}

function decodeOrThrow(raw: unknown): ArchitectureOptions {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const cached = decodedCache.get(raw);
    if (cached) return cached;
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
        message: `Invalid agent-code-guard architecture options:\n${summary}`,
        issues,
      });
    },
    onRight: (parsed) => {
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        decodedCache.set(raw, parsed);
      }
      return parsed;
    },
  });
}

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

export type { ArchitectureOptionsInput } from "./config-schema.js";
