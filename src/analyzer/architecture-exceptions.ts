/**
 * @file Reading and indexing of `safer-arch-ignore` suppression directives.
 * A directive is one comment line naming a known rule plus a written reason,
 * and every way it can be wrong becomes a reported parse error rather than a
 * silently ignored comment, so a waiver never stops working unnoticed.
 */
import ts from "typescript";
import {
  ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  type ArchitectureDiagnosticRuleId,
} from "./rule-ids.js";

// safer-arch-ignore no-large-folder: analyzer children are intentionally one folder per analysis concern and already converge on the single analyzer facade.

const DIRECTIVE_MARKER = "safer-arch-ignore";
// The retired two-line marker. It is NEVER honored — seeing it produces a
// tombstone parse error so a stale suppression can't silently stop working.
const LEGACY_MARKER = "@agent-code-guard/architecture-exception";
const RULE_ID_SET: ReadonlySet<string> = new Set(ARCHITECTURE_DIAGNOSTIC_RULE_IDS);

interface ArchitectureDirective {
  readonly ruleId: ArchitectureDiagnosticRuleId;
  readonly reason: string;
}

/**
 * The directives one file carries. Suppression is file-scoped, so where in
 * the file a directive was written is not retained.
 */
export interface FileDirectives {
  readonly file: string;
  readonly directives: readonly ArchitectureDirective[];
}

interface DirectiveParseError {
  readonly file: string;
  readonly line: number;
  readonly ruleId: ArchitectureDiagnosticRuleId | null;
  readonly message: string;
}

/**
 * Both halves of a file's parse: the directives that will suppress
 * diagnostics, and the malformed lines that are surfaced to the user instead
 * of being dropped.
 */
export interface DirectiveParseResult {
  readonly directives: readonly ArchitectureDirective[];
  readonly errors: readonly DirectiveParseError[];
}

interface CommentLine {
  readonly line: number;
  readonly content: string;
}

interface ParseState {
  readonly directives: ArchitectureDirective[];
  readonly errors: DirectiveParseError[];
}

/**
 * Read a file's suppression directives out of its comments. Every leading and
 * trailing comment on every node is inspected, so a directive is honored
 * wherever the author put it.
 * @param sourceFile Parsed file whose comment trivia is searched for
 * directive lines.
 * @returns The file's valid directives alongside the parse errors that must
 * be reported to the user.
 */
export function parseDirectivesFromSourceFile(
  sourceFile: ts.SourceFile,
): DirectiveParseResult {
  const commentLines = collectCommentLines(sourceFile);
  return parseCommentLines(sourceFile.fileName, commentLines);
}

function collectCommentLines(sourceFile: ts.SourceFile): CommentLine[] {
  const text = sourceFile.text;
  const lineOf = (pos: number) =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const comments = new Map<number, ts.CommentRange>();
  collectCommentRanges(sourceFile, text, comments);
  return [...comments.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, comment]) => commentLinesFromRange(text, lineOf, comment));
}

function collectCommentRanges(
  sourceFile: ts.SourceFile,
  text: string,
  comments: Map<number, ts.CommentRange>,
): void {
  const addComment = (pos: number, end: number, kind: ts.CommentKind) => {
    comments.set(pos, { end, hasTrailingNewLine: false, kind, pos });
  };
  const visit = (node: ts.Node) => {
    ts.forEachLeadingCommentRange(text, node.pos, addComment);
    ts.forEachTrailingCommentRange(text, node.end, addComment);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function commentLinesFromRange(
  text: string,
  lineOf: (pos: number) => number,
  comment: ts.CommentRange,
): readonly CommentLine[] {
  const raw = text.slice(comment.pos, comment.end);
  return comment.kind === ts.SyntaxKind.SingleLineCommentTrivia
    ? [{ line: lineOf(comment.pos), content: raw.slice(2).trim() }]
    : blockCommentLines(raw, comment.pos, lineOf);
}

function blockCommentPrefixLength(raw: string): number {
  let cursor = raw.startsWith("/*") ? 2 : 0;
  while (raw[cursor] === "*") {cursor += 1;}
  return cursor;
}

function blockCommentContentEnd(raw: string): number {
  let end = raw.endsWith("/") ? raw.length - 1 : raw.length;
  while (raw[end - 1] === "*") {end -= 1;}
  return end;
}

function stripBlockLinePrefix(segment: string): string {
  const trimmed = segment.trimStart();
  return trimmed.startsWith("*") ? trimmed.slice(1).trim() : trimmed.trim();
}

function blockCommentLines(
  raw: string,
  start: number,
  lineOf: (pos: number) => number,
): readonly CommentLine[] {
  const prefixLength = blockCommentPrefixLength(raw);
  const inner = raw.slice(prefixLength, blockCommentContentEnd(raw));
  let cursor = 0;
  return inner.split(/\r?\n/).map((segment) => {
    const line = {
      line: lineOf(start + prefixLength + cursor),
      content: stripBlockLinePrefix(segment),
    };
    cursor += segment.length + 1;
    return line;
  });
}

// Grammar: `safer-arch-ignore <rule-id>: <reason>` on one comment line.
// The reason is mandatory and non-empty; suppression is file-scoped.
const DIRECTIVE_LINE = new RegExp(`^${DIRECTIVE_MARKER}\\s+([\\w-]+)\\s*:\\s*(.*)$`);

function parseCommentLines(
  filePath: string,
  commentLines: readonly CommentLine[],
): DirectiveParseResult {
  const state: ParseState = { directives: [], errors: [] };
  for (const commentLine of commentLines) {handleCommentLine(state, filePath, commentLine);}
  return { directives: state.directives, errors: state.errors };
}

function handleCommentLine(
  state: ParseState,
  filePath: string,
  commentLine: CommentLine,
): void {
  const { line, content } = commentLine;
  if (content.startsWith(LEGACY_MARKER)) {
    state.errors.push(legacyMarkerError(filePath, line));
    return;
  }
  if (!content.startsWith(DIRECTIVE_MARKER)) {return;}
  const match = DIRECTIVE_LINE.exec(content);
  if (match === null) {
    state.errors.push(malformedError(filePath, line));
    return;
  }
  const [, candidate = "", reason = ""] = match;
  if (!RULE_ID_SET.has(candidate)) {
    state.errors.push(unknownRuleError(filePath, line, candidate));
    return;
  }
  const ruleId =
    // The guard above rejects any candidate missing from RULE_ID_SET, whose
    // members are exactly the members of this union, so the cast is safe.
    candidate as ArchitectureDiagnosticRuleId;
  if (reason.trim().length === 0) {
    state.errors.push(emptyReasonError(filePath, line, ruleId));
    return;
  }
  state.directives.push({ ruleId, reason: reason.trim() });
}

function legacyMarkerError(filePath: string, line: number): DirectiveParseError {
  return {
    file: filePath,
    line,
    ruleId: null,
    message: `Legacy '${LEGACY_MARKER}' directives are not honored. Rewrite as '${DIRECTIVE_MARKER} <rule-id>: <reason>'.`,
  };
}

function malformedError(filePath: string, line: number): DirectiveParseError {
  return {
    file: filePath,
    line,
    ruleId: null,
    message: `Malformed '${DIRECTIVE_MARKER}' directive. Expected '${DIRECTIVE_MARKER} <rule-id>: <reason>' on one comment line.`,
  };
}

function unknownRuleError(
  filePath: string,
  line: number,
  candidate: string,
): DirectiveParseError {
  return {
    file: filePath,
    line,
    ruleId: null,
    message: `Unknown architecture rule id '${candidate}' in directive. Expected one of: ${ARCHITECTURE_DIAGNOSTIC_RULE_IDS.join(", ")}.`,
  };
}

function emptyReasonError(
  filePath: string,
  line: number,
  ruleId: ArchitectureDiagnosticRuleId,
): DirectiveParseError {
  return {
    file: filePath,
    line,
    ruleId,
    message: `Empty reason for directive '${DIRECTIVE_MARKER} ${ruleId}: <reason>'. The written reason is mandatory.`,
  };
}

/**
 * Project-wide suppression lookup, from resolved file path to rule id to the
 * reason that was written for it.
 */
export type DirectiveIndex = ReadonlyMap<
  string,
  ReadonlyMap<ArchitectureDiagnosticRuleId, string>
>;

/**
 * Collapse per-file directives into one project-wide lookup. Reasons are
 * retained per file and rule so the report can surface the auditable waiver
 * ledger. First directive wins on duplicates.
 * @param fileDirectives One entry per file that carried at least one
 * directive, paths already resolved.
 * @returns The lookup that suppression checks and the waiver ledger both
 * read.
 */
export function buildDirectiveIndex(
  fileDirectives: readonly FileDirectives[],
): DirectiveIndex {
  const index = new Map<string, Map<ArchitectureDiagnosticRuleId, string>>();
  for (const { file, directives } of fileDirectives) {
    let byRule = index.get(file);
    if (!byRule) {
      byRule = new Map();
      index.set(file, byRule);
    }
    for (const d of directives) {
      if (!byRule.has(d.ruleId)) {byRule.set(d.ruleId, d.reason);}
    }
  }
  return index;
}

/**
 * Decide whether a diagnostic has been waived by its own file.
 * @param index Project-wide lookup produced by `buildDirectiveIndex`.
 * @param file Resolved path of the file the diagnostic points at; it must be
 * resolved the same way the index keys were.
 * @param ruleId The rule that produced the diagnostic under test.
 * @returns True when that file wrote a directive for that rule.
 */
export function isDirectiveSuppressed(
  index: DirectiveIndex,
  file: string,
  ruleId: ArchitectureDiagnosticRuleId,
): boolean {
  return index.get(file)?.has(ruleId) ?? false;
}
