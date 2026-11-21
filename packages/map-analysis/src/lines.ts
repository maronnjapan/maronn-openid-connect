/**
 * The lines a pull request adds, counted by what they hold: only a comment,
 * or code. The comment on the pull request says both numbers
 * (changesMarkdown), so a review sees how much prose came with the code
 * (apps/map/docs/design-request-premises.md「書く量を増やさない」).
 *
 * Counted are the added lines of the TypeScript and JavaScript files of the
 * diff, outside the tests and their support code (roots.ts
 * isTestSupportPath) and the samples the CLI generates (samples/). The
 * scanner of TypeScript tells what a line holds: a token other than a
 * comment makes it code (a comment after the code too), comment text alone
 * makes it a comment, and a blank line, in a comment too, is neither.
 */
import { isTestSupportPath } from './roots.js';
import { createScanner, SyntaxKind } from './ts.js';

export type LineKind = 'comment' | 'code' | 'blank';

/** The tokens a value ends with: a `/` after one divides, any other `/` starts a regular expression. */
const VALUE_ENDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

/** The index of the first character of each line of a text, the lines as git counts them (ended by a line feed). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

/**
 * What each line of a TypeScript or JavaScript text holds, from its first
 * line (see the module comment). The scanner runs without a parser, so two
 * tokens are told by what stands before them: a `/` starts a regular
 * expression unless a value ends before it, and a `}` continues a template
 * when it closes the `${` of one.
 */
export function lineKinds(text: string): LineKind[] {
  const starts = lineStarts(text);
  const kinds: LineKind[] = starts.map(() => 'blank');
  const lineAt = (position: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const mark = (from: number, to: number, kind: 'comment' | 'code') => {
    const last = lineAt(Math.max(from, to - 1));
    for (let line = lineAt(from); line <= last; line += 1) {
      if (kind === 'code') kinds[line] = 'code';
      else if (kinds[line] === 'blank' && text.slice(Math.max(from, starts[line] as number), Math.min(to, starts[line + 1] ?? text.length)).trim() !== '') kinds[line] = 'comment';
    }
  };
  const scanner = createScanner(false, undefined, text);
  /** The braces open inside each `${` of the templates the scanner is in, the innermost last. */
  const templates: number[] = [];
  let previous: SyntaxKind | undefined;
  for (;;) {
    let token = scanner.scan();
    if (token === SyntaxKind.EndOfFile) break;
    if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) && (previous === undefined || !VALUE_ENDS.has(previous))) token = scanner.reScanSlashToken();
    const open = templates.length - 1;
    if (token === SyntaxKind.TemplateHead) templates.push(0);
    else if (token === SyntaxKind.OpenBraceToken && open >= 0) templates[open] = (templates[open] as number) + 1;
    else if (token === SyntaxKind.CloseBraceToken && open >= 0) {
      if ((templates[open] as number) > 0) templates[open] = (templates[open] as number) - 1;
      else {
        token = scanner.reScanTemplateToken(false);
        if (token === SyntaxKind.TemplateTail) templates.pop();
      }
    }
    if (token === SyntaxKind.WhitespaceTrivia || token === SyntaxKind.NewLineTrivia) continue;
    const comment = token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia;
    mark(scanner.getTokenStart(), scanner.getTokenEnd(), comment ? 'comment' : 'code');
    if (!comment) previous = token;
  }
  return kinds;
}

/**
 * The lines each file gains in the output of `git diff --unified=0`: its
 * path after the change → the numbers of its added lines. The lines of a
 * hunk are skipped by the counts of its header, so a line of a file that
 * reads like a header is not taken for one.
 */
export function addedLines(diff: string): Map<string, number[]> {
  const files = new Map<string, number[]>();
  const lines = diff.split('\n');
  let current: number[] | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/\t$/, '');
      current = path === '/dev/null' ? undefined : [];
      if (current !== undefined) files.set(path.replace(/^b\//, ''), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const added = hunk[3] === undefined ? 1 : Number(hunk[3]);
    for (let offset = 0; offset < added; offset += 1) current?.push(Number(hunk[2]) + offset);
    let body = (hunk[1] === undefined ? 1 : Number(hunk[1])) + added;
    while (body > 0 && index + 1 < lines.length) {
      index += 1;
      if (!(lines[index] as string).startsWith('\\')) body -= 1;
    }
  }
  return files;
}

/** Whether the added lines of a path are counted: TypeScript or JavaScript that is no declaration file, no test or test support code, and none of the generated samples. */
export function isCountedPath(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path) && !isTestSupportPath(path) && !path.startsWith('samples/');
}

/**
 * The added lines of the counted files (isCountedPath) by what they hold.
 * `files` gives the added lines of each path, or undefined for a file that
 * is new as a whole; `read` gives the text of a path after the change.
 */
export function countAddedLines(files: Iterable<readonly [path: string, lines: readonly number[] | undefined]>, read: (path: string) => string): { comment: number; code: number } {
  const counts = { comment: 0, code: 0 };
  for (const [path, lines] of files) {
    if (!isCountedPath(path)) continue;
    const kinds = lineKinds(read(path));
    for (const kind of lines === undefined ? kinds : lines.map((line) => kinds[line - 1])) {
      if (kind === 'comment' || kind === 'code') counts[kind] += 1;
    }
  }
  return counts;
}
