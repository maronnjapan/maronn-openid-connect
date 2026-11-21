/**
 * The lines a pull request adds to the code, by what they hold
 * (MapChanges.addedLines): a line with a token of the language is code, a
 * line with comments and no token a comment line, as the scanner of
 * TypeScript reads them; blank lines count for neither. The tests and their
 * support code (roots.ts isTestSupportPath) and the code `maronn-oidc
 * generate` writes into the samples are left out.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isTestSupportPath } from './roots.js';
import { LanguageVariant, SyntaxKind, createScanner } from './ts.js';

/** What a line of a source file holds. */
export type LineKind = 'code' | 'comment' | 'blank';

/** The keywords after which a `/` starts a regular expression. */
const REGEX_AFTER = new Set<SyntaxKind>([
  SyntaxKind.ReturnKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.YieldKeyword,
  SyntaxKind.AwaitKeyword,
]);

/** The tokens that end a value, after which a `/` divides. */
const VALUE_ENDS = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

/** Whether a `/` after a token starts a regular expression: not after a value, nor after a keyword other than those of REGEX_AFTER (`this`, `null`). */
function slashStartsRegex(previous: SyntaxKind | undefined): boolean {
  if (previous === undefined) return true;
  if (previous >= SyntaxKind.FirstKeyword && previous <= SyntaxKind.LastKeyword) return REGEX_AFTER.has(previous);
  return !VALUE_ENDS.has(previous);
}

/**
 * What each line of a source file holds (the first at 0), the lines split
 * at `\n` as git splits them. The scanner reads a template and a regular
 * expression whole when told to, as a parser does: after the `}` of a `${`,
 * and at a `/` that starts a regular expression (slashStartsRegex).
 */
export function lineKinds(text: string, jsx = false): LineKind[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  const kinds: LineKind[] = starts.map(() => 'blank');
  const lineOf = (position: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const mark = (start: number, end: number, kind: 'code' | 'comment') => {
    for (let line = lineOf(start), last = lineOf(Math.max(start, end - 1)); line <= last; line += 1) if (kind === 'code' || kinds[line] === 'blank') kinds[line] = kind;
  };
  const scanner = createScanner(false, jsx ? LanguageVariant.JSX : LanguageVariant.Standard, text);
  // The braces open at the scanner: a `{`, or the `${` of a template.
  const braces: Array<'block' | 'template'> = [];
  let previous: SyntaxKind | undefined;
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token === SyntaxKind.WhitespaceTrivia || token === SyntaxKind.NewLineTrivia) continue;
    if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) {
      mark(scanner.getTokenStart(), scanner.getTokenEnd(), 'comment');
      continue;
    }
    if (token === SyntaxKind.OpenBraceToken) braces.push('block');
    else if (token === SyntaxKind.TemplateHead) braces.push('template');
    else if (token === SyntaxKind.CloseBraceToken) {
      if (braces.pop() === 'template') {
        token = scanner.reScanTemplateToken(false);
        if (token === SyntaxKind.TemplateMiddle) braces.push('template');
      }
    } else if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) && slashStartsRegex(previous)) token = scanner.reScanSlashToken();
    mark(scanner.getTokenStart(), scanner.getTokenEnd(), 'code');
    previous = token;
  }
  return kinds;
}

/** A path as git writes it in a diff: in double quotes with C escapes when it has a character git escapes. */
function unquoted(name: string): string {
  if (!name.startsWith('"')) return name;
  return JSON.parse(name.replace(/\\([0-7]{3})/g, (_match, octal: string) => `\\u${Number.parseInt(octal, 8).toString(16).padStart(4, '0')}`).replace(/\\a/g, '\\u0007').replace(/\\v/g, '\\u000b')) as string;
}

/**
 * The lines a diff of `git diff --unified=0 --src-prefix=a/ --dst-prefix=b/`
 * adds to each file, by its path after (the first line at 1). The hunks are
 * read by their counts, so a line of a hunk never reads as a header.
 */
export function addedLinesOf(diff: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let path: string | undefined;
  let rest = 0;
  for (const line of diff.split('\n')) {
    if (rest > 0) {
      if (line.startsWith('+') || line.startsWith('-')) rest -= 1;
      continue;
    }
    if (line.startsWith('diff --git ')) path = undefined;
    else if (line.startsWith('+++ ')) {
      const name = unquoted(line.slice(4));
      path = name.startsWith('b/') ? name.slice(2) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const count = hunk[3] === undefined ? 1 : Number(hunk[3]);
    rest = (hunk[1] === undefined ? 1 : Number(hunk[1])) + count;
    if (path === undefined || count === 0) continue;
    const lines = added.get(path) ?? [];
    for (let offset = 0; offset < count; offset += 1) lines.push(Number(hunk[2]) + offset);
    added.set(path, lines);
  }
  return added;
}

/**
 * The directories `maronn-oidc generate` writes into the samples, from the
 * root of the repository: the `--output` of each sample's `generate` script
 * (samples/<name>/package.json), which its check-generated.mjs keeps in step.
 */
export function generatedDirectories(repository: string): string[] {
  const samples = join(repository, 'samples');
  if (!existsSync(samples)) return [];
  return readdirSync(samples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(samples, entry.name, 'package.json')))
    .flatMap((entry) => {
      const script = (JSON.parse(readFileSync(join(samples, entry.name, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts?.['generate'];
      const output = script === undefined ? undefined : /--output\s+(\S+)/.exec(script)?.[1];
      return output === undefined ? [] : [`${posix.join('samples', entry.name, output)}/`];
    })
    .sort();
}

/** Whether the lines added to a file count (see the module comment): a source of TypeScript or JavaScript outside the tests (the declarations under tests/ too) and the generated directories. */
export function countsLines(path: string, generated: readonly string[]): boolean {
  return /\.[cm]?[jt]sx?$/.test(path) && !isTestSupportPath(path) && !path.startsWith('tests/') && !generated.some((directory) => path.startsWith(directory));
}

/** The added lines of the files that count (countsLines), by what they hold in the files as they are now. */
export function countAddedLines(added: ReadonlyMap<string, readonly number[]>, read: (path: string) => string, generated: readonly string[]): { comment: number; code: number } {
  const total = { comment: 0, code: 0 };
  for (const [path, lines] of added) {
    if (!countsLines(path, generated)) continue;
    let text: string;
    try {
      text = read(path);
    } catch {
      continue;
    }
    const kinds = lineKinds(text, /\.[jt]sx$/.test(path));
    for (const line of lines) {
      const kind = kinds[line - 1];
      if (kind === 'code' || kind === 'comment') total[kind] += 1;
    }
  }
  return total;
}
