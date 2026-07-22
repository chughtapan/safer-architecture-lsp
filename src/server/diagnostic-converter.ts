/**
 * @file Convert analyzer `ArchitectureDiagnostic` values into LSP
 * `Diagnostic` values for `publishDiagnostics`. Architecture findings
 * are file-level (not line-range-bound) — they map to the start of the
 * file with `agent-code-guard` as the source and the rule id as the
 * code. Editors group findings by `code` automatically.
 */

import { pathToFileURL } from "node:url";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver";
import type { ArchitectureDiagnostic } from "../analyzer/project/api/index.js";
import { ruleCodeDescription } from "./rule-docs.js";

const FILE_HEAD_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

/**
 * Convert one analyzer diagnostic to an LSP diagnostic. The
 * `codeDescription.href` field is the editor-visible "Learn more"
 * URL; it points at the rule's PRINCIPLES.md anchor.
 * @param finding Analyzer's architecture diagnostic.
 * @returns LSP diagnostic, pinned to the start of the file.
 */
function toLspDiagnostic(finding: ArchitectureDiagnostic): Diagnostic {
  return {
    range: FILE_HEAD_RANGE,
    severity:
      finding.severity === "error"
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning,
    code: finding.ruleId,
    codeDescription: ruleCodeDescription(finding.ruleId),
    source: "agent-code-guard",
    message: finding.message,
  };
}

/**
 * Group analyzer diagnostics by file URI. The LSP server publishes
 * one `publishDiagnostics` per URI, so findings are batched here.
 * Per-file URI conversion is memoized within the batch — architecture
 * findings are file-level and the same file commonly carries
 * findings from several rules.
 * @param findings Findings from one or more files.
 * @returns Map of URI to LSP diagnostics for that URI.
 */
export function groupByUri(
  findings: readonly ArchitectureDiagnostic[],
): ReadonlyMap<string, readonly Diagnostic[]> {
  const uriByFile = new Map<string, string>();
  const groups = new Map<string, Diagnostic[]>();
  for (const finding of findings) {
    let uri = uriByFile.get(finding.file);
    if (uri === undefined) {
      uri = pathToFileURL(finding.file).toString();
      uriByFile.set(finding.file, uri);
    }
    let bucket = groups.get(uri);
    if (bucket === undefined) {
      bucket = [];
      groups.set(uri, bucket);
    }
    bucket.push(toLspDiagnostic(finding));
  }
  return groups;
}
