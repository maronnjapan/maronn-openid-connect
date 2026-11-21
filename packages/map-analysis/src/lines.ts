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
  SyntaxKind.CloseBracketToken,
]);

/** The keywords whose `(…)` is a condition or a head, after whose `)` a statement (and a regular expression) can start. */
const CONTROL = new Set<SyntaxKind>([SyntaxKind.IfKeyword, SyntaxKind.WhileKeyword, SyntaxKind.ForKeyword, SyntaxKind.WithKeyword]);

/**
 * What each line of a source file holds (the first at 0), the lines split
 * at `\n` as git splits them. The scanner reads a template and a regular
 * expression whole when told to, as a parser does: after the `}` of a `${`,
 * and at a `/` where no value ends (after a value a `/` divides). A value
 * ends at a name, a literal, `]`, a `)` other than that of `if (…)`,
 * `while (…)`, `for (…)` or `with (…)`, a postfix `!`, `++` or `--`, and a
 * keyword other than REGEX_AFTER, or any after `.` (a name). A token the
 * scanner does not move past counts as one character of code.
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
  // The braces open at the scanner (a `{`, or the `${` of a template) and the parentheses (whether of a condition).
  const braces: Array<'block' | 'template'> = [];
  const parens: boolean[] = [];
  let previous: SyntaxKind | undefined;
  let previousName = false;
  let ended = false;
  for (let position = 0; position < text.length; ) {
    let token = scanner.scan();
    if (token === SyntaxKind.EndOfFile) break;
    if (scanner.getTokenEnd() <= position) {
      mark(position, position + 1, 'code');
      position += 1;
      scanner.resetTokenState(position);
      previous = undefined;
      previousName = false;
      ended = false;
      continue;
    }
    position = scanner.getTokenEnd();
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
    } else if ((token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) && !ended) token = scanner.reScanSlashToken();
    position = scanner.getTokenEnd();
    mark(scanner.getTokenStart(), position, 'code');
    const keyword = token >= SyntaxKind.FirstKeyword && token <= SyntaxKind.LastKeyword;
    const name = keyword && (previous === SyntaxKind.DotToken || previous === SyntaxKind.QuestionDotToken);
    if (token === SyntaxKind.OpenParenToken) parens.push(previous !== undefined && CONTROL.has(previous) && !previousName);
    ended =
      keyword
        ? name || !REGEX_AFTER.has(token)
        : token === SyntaxKind.CloseParenToken
          ? parens.pop() !== true
          : token === SyntaxKind.ExclamationToken || token === SyntaxKind.PlusPlusToken || token === SyntaxKind.MinusMinusToken
            ? ended
            : VALUE_ENDS.has(token);
    previous = token;
    previousName = name;
  }
  return kinds;
}

/** A path as git writes it in a diff: in double quotes with the escapes of C when it has a character git escapes, read left to right. */
function unquoted(name: string): string {
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let index = 1; index < name.length - 1; index += 1) {
    const char = name[index] as string;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(name.slice(index + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    index += 1;
    bytes.push(escapes[name[index] as string] ?? (name[index] as string).charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The lines a diff of `git diff --unified=0 --src-prefix=a/ --dst-prefix=b/`
 * adds to each file, by its path after (the first line at 1). A hunk is read
 * to the end its header counts, by the first character of each line: `+`
 * adds a line, ` ` keeps one, `-` removes one; so a line of a hunk never
 * reads as a header.
 */
export function addedLinesOf(diff: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let path: string | undefined;
  let before = 0;
  let after = 0;
  let line = 0;
  for (const text of diff.split('\n')) {
    if (before > 0 || after > 0) {
      if (text.startsWith('+')) {
        if (path !== undefined) added.set(path, [...(added.get(path) ?? []), line]);
        line += 1;
        after -= 1;
      } else if (text.startsWith('-')) before -= 1;
      else if (text.startsWith(' ')) {
        line += 1;
        before -= 1;
        after -= 1;
      }
      continue;
    }
    if (text.startsWith('diff --git ')) path = undefined;
    else if (text.startsWith('+++ ')) {
      // git ends the name with a tab when it holds a space.
      const name = unquoted(text.slice(4).replace(/\t$/, ''));
      path = name.startsWith('b/') ? name.slice(2) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk === null) continue;
    before = hunk[1] === undefined ? 1 : Number(hunk[1]);
    after = hunk[3] === undefined ? 1 : Number(hunk[3]);
    line = Number(hunk[2]);
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
