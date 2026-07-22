import ts from "typescript";
import {
  ARCHITECTURE_DIAGNOSTIC_RULE_IDS,
  type ArchitectureDiagnosticRuleId,
} from "./rule-ids.js";

const DIRECTIVE_MARKER = "@agent-code-guard/architecture-exception";
const RULE_ID_SET: ReadonlySet<string> = new Set(ARCHITECTURE_DIAGNOSTIC_RULE_IDS);

interface ArchitectureDirective {
  readonly ruleId: ArchitectureDiagnosticRuleId;
  readonly reason: string;
}

export interface FileDirectives {
  readonly file: string;
  readonly directives: ReadonlyArray<ArchitectureDirective>;
}

interface DirectiveParseError {
  readonly file: string;
  readonly line: number;
  readonly ruleId: ArchitectureDiagnosticRuleId | null;
  readonly message: string;
}

export interface DirectiveParseResult {
  readonly directives: ReadonlyArray<ArchitectureDirective>;
  readonly errors: ReadonlyArray<DirectiveParseError>;
}

const missingReasonError = (
  filePath: string,
  line: number,
  ruleId: ArchitectureDiagnosticRuleId,
): DirectiveParseError => ({
  file: filePath,
  line,
  ruleId,
  message: `Directive '${DIRECTIVE_MARKER}: ${ruleId}' is missing a 'reason:' follow-up line.`,
});

interface CommentLine {
  readonly line: number;
  readonly content: string;
}

interface PendingDirective {
  readonly ruleId: ArchitectureDiagnosticRuleId;
  readonly line: number;
}

interface ParseState {
  pending: PendingDirective | null;
  readonly directives: ArchitectureDirective[];
  readonly errors: DirectiveParseError[];
}

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
  while (raw[cursor] === "*") cursor += 1;
  return cursor;
}

function blockCommentContentEnd(raw: string): number {
  let end = raw.endsWith("/") ? raw.length - 1 : raw.length;
  while (raw[end - 1] === "*") end -= 1;
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

function parseCommentLines(
  filePath: string,
  commentLines: ReadonlyArray<CommentLine>,
): DirectiveParseResult {
  const state: ParseState = { directives: [], errors: [], pending: null };
  const strictMatcher = new RegExp(
    `^${escapeForRegExp(DIRECTIVE_MARKER)}\\s*:\\s*([\\w-]+)\\s*$`,
  );

  for (const commentLine of commentLines) handleCommentLine(state, filePath, commentLine, strictMatcher);
  flushPendingDirective(state, filePath);
  return { directives: state.directives, errors: state.errors };
}

function handleCommentLine(
  state: ParseState,
  filePath: string,
  commentLine: CommentLine,
  strictMatcher: RegExp,
): void {
  const candidate = strictDirectiveRuleId(commentLine.content, strictMatcher);
  if (candidate !== null) {
    handleDirectiveLine(state, filePath, commentLine.line, candidate);
    return;
  }
  if (commentLine.content.startsWith(DIRECTIVE_MARKER)) {
    handleMalformedDirectiveLine(state, filePath, commentLine.line);
    return;
  }
  if (state.pending !== null) handlePotentialReasonLine(state, filePath, commentLine);
}

function strictDirectiveRuleId(content: string, strictMatcher: RegExp): string | null {
  const ruleMatch = content.match(strictMatcher);
  return ruleMatch?.[1] ?? null;
}

function handleDirectiveLine(
  state: ParseState,
  filePath: string,
  line: number,
  candidate: string,
): void {
  flushPendingDirective(state, filePath);
  if (!RULE_ID_SET.has(candidate)) {
    state.errors.push(unknownRuleError(filePath, line, candidate));
    return;
  }
  state.pending = { line, ruleId: candidate as ArchitectureDiagnosticRuleId };
}

function handleMalformedDirectiveLine(
  state: ParseState,
  filePath: string,
  line: number,
): void {
  flushPendingDirective(state, filePath);
  state.errors.push({
    file: filePath,
    line,
    ruleId: null,
    message: `Malformed '${DIRECTIVE_MARKER}' directive. Expected '${DIRECTIVE_MARKER}: <rule-id>' on its own line.`,
  });
}

function handlePotentialReasonLine(
  state: ParseState,
  filePath: string,
  commentLine: CommentLine,
): void {
  const reason = parseReason(commentLine.content);
  if (reason === null) {
    flushPendingDirective(state, filePath);
    return;
  }
  addReasonResult(state, filePath, commentLine.line, reason);
}

function parseReason(content: string): string | null {
  const separator = content.indexOf(":");
  if (separator < 0) return null;
  const key = content.slice(0, separator).trim().toLowerCase();
  return key === "reason" ? content.slice(separator + 1).trim() : null;
}

function addReasonResult(
  state: ParseState,
  filePath: string,
  line: number,
  reason: string,
): void {
  const pending = state.pending;
  if (pending === null) return;
  if (reason.length === 0) {
    state.errors.push(emptyReasonError(filePath, line, pending.ruleId));
  } else {
    state.directives.push({ ruleId: pending.ruleId, reason });
  }
  state.pending = null;
}

function flushPendingDirective(state: ParseState, filePath: string): void {
  if (state.pending === null) return;
  state.errors.push(
    missingReasonError(filePath, state.pending.line, state.pending.ruleId),
  );
  state.pending = null;
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
    message: `Empty 'reason:' for directive '${DIRECTIVE_MARKER}: ${ruleId}'. Provide a written reason.`,
  };
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildDirectiveIndex(
  fileDirectives: ReadonlyArray<FileDirectives>,
): ReadonlyMap<string, ReadonlySet<ArchitectureDiagnosticRuleId>> {
  const index = new Map<string, Set<ArchitectureDiagnosticRuleId>>();
  for (const { file, directives } of fileDirectives) {
    let set = index.get(file);
    if (!set) {
      set = new Set();
      index.set(file, set);
    }
    for (const d of directives) {
      set.add(d.ruleId);
    }
  }
  return index;
}

export function isDirectiveSuppressed(
  index: ReadonlyMap<string, ReadonlySet<ArchitectureDiagnosticRuleId>>,
  file: string,
  ruleId: ArchitectureDiagnosticRuleId,
): boolean {
  return index.get(file)?.has(ruleId) ?? false;
}
