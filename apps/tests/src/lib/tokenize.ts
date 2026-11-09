/**
 * Syntax highlighting of the test files, small on purpose: TypeScript (and
 * JavaScript) and Gherkin, read into keywords, strings, comments, numbers and
 * the tags and placeholders of a scenario. It is not a parser: a regular
 * expression literal reads as plain text, and a quote inside one may color
 * the rest of its line as a string, which a reader of a test can live with.
 *
 * The text is read whole, so a comment or a template literal across lines
 * colors every line it spans, then split into lines for the code view.
 */

export type TokenType = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'tag' | 'punct';

export interface Token {
  type: TokenType;
  text: string;
}

export type Language = 'ts' | 'gherkin' | 'plain';

/** The language of a file by its extension. */
export function languageOf(path: string): Language {
  if (path.endsWith('.feature')) return 'gherkin';
  if (/\.[cm]?[jt]sx?$/.test(path)) return 'ts';
  return 'plain';
}

const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly',
  'return', 'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'var', 'void', 'while', 'yield',
]);

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/y;

/** Append a token, merging it into the last one of the same type so a line holds few spans. */
function pushTo(tokens: Token[], type: TokenType, text: string): void {
  if (text === '') return;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.type === type) last.text += text;
  else tokens.push({ type, text });
}

/** The end of a quoted string that starts at `start`: past its closing quote, or at the end of its line when it has none. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote && text[index] !== '\n') index += text[index] === '\\' ? 2 : 1;
  return text[index] === quote ? index + 1 : Math.min(index, text.length);
}

/** Read TypeScript into tokens. */
export function tokenizeTs(text: string): Token[] {
  const tokens: Token[] = [];
  const push = (type: TokenType, part: string): void => pushTo(tokens, type, part);

  // Code from `start`; inside a `${...}` of a template it stops at the brace
  // that closes it (braces of objects and blocks in between are counted) and
  // returns its index.
  const code = (start: number, nested: boolean): number => {
    let index = start;
    let plainFrom = start;
    let depth = 0;
    const flush = (to: number): void => push('plain', text.slice(plainFrom, to));
    while (index < text.length) {
      const char = text[index] as string;
      const next = text[index + 1];
      if (char === '/' && (next === '/' || next === '*')) {
        flush(index);
        const close = next === '/' ? text.indexOf('\n', index) : text.indexOf('*/', index + 2);
        const end = close === -1 ? text.length : next === '/' ? close : close + 2;
        push('comment', text.slice(index, end));
        index = plainFrom = end;
        continue;
      }
      if (char === '"' || char === "'") {
        flush(index);
        const end = stringEnd(text, index);
        push('string', text.slice(index, end));
        index = plainFrom = end;
        continue;
      }
      if (char === '`') {
        flush(index);
        index = plainFrom = template(index);
        continue;
      }
      if (nested && char === '{') depth += 1;
      if (nested && char === '}') {
        if (depth === 0) {
          flush(index);
          return index;
        }
        depth -= 1;
      }
      if (/[A-Za-z_$]/.test(char)) {
        IDENTIFIER.lastIndex = index;
        const word = IDENTIFIER.exec(text)?.[0] ?? char;
        // A property (`.default`, `.type`) is a name, not the keyword.
        if (KEYWORDS.has(word) && text[index - 1] !== '.') {
          flush(index);
          push('keyword', word);
          plainFrom = index + word.length;
        }
        index += word.length;
        continue;
      }
      if (/\d/.test(char)) {
        NUMBER.lastIndex = index;
        const number = NUMBER.exec(text)?.[0] ?? char;
        flush(index);
        push('number', number);
        index = plainFrom = index + number.length;
        continue;
      }
      index += 1;
    }
    flush(index);
    return index;
  };

  // A template literal from its opening backquote; returns the index past its closing one.
  const template = (start: number): number => {
    let index = start + 1;
    let from = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '`') {
        push('string', text.slice(from, index + 1));
        return index + 1;
      }
      if (char === '$' && text[index + 1] === '{') {
        push('string', text.slice(from, index));
        push('punct', '${');
        const close = code(index + 2, true);
        if (close < text.length) push('punct', '}');
        index = from = Math.min(close + 1, text.length);
        continue;
      }
      index += 1;
    }
    push('string', text.slice(from));
    return text.length;
  };

  code(0, false);
  return tokens;
}

const GHERKIN_HEAD = /^(\s*)(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Examples|Example|Scenarios)(:)(.*)$/;
const GHERKIN_STEP = /^(\s*)(Given|When|Then|And|But|\*)( .*|)$/;

/** The words of a step or a cell: strings, numbers and the `<placeholders>` of an outline. */
function gherkinInline(tokens: Token[], text: string): void {
  const pattern = /("(?:[^"\\]|\\.)*"?)|(<[^<>\s]+>)|(\b\d+(?:\.\d+)?\b)|(\|)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushTo(tokens, 'plain', text.slice(last, index));
    const type: TokenType = match[1] !== undefined ? 'string' : match[2] !== undefined ? 'tag' : match[3] !== undefined ? 'number' : 'punct';
    pushTo(tokens, type, match[0]);
    last = index + match[0].length;
  }
  pushTo(tokens, 'plain', text.slice(last));
}

/** Read a feature file into lines of tokens. */
export function tokenizeGherkin(text: string): Token[][] {
  const lines: Token[][] = [];
  let docString: string | undefined;
  for (const line of text.split('\n')) {
    const tokens: Token[] = [];
    const trimmed = line.trimStart();
    const fence = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith('```') ? '```' : undefined;
    if (docString !== undefined) {
      pushTo(tokens, 'string', line);
      if (fence === docString) docString = undefined;
    } else if (fence !== undefined) {
      pushTo(tokens, 'string', line);
      docString = fence;
    } else if (trimmed.startsWith('#')) {
      pushTo(tokens, 'comment', line);
    } else if (trimmed.startsWith('@')) {
      for (const part of line.split(/(\s+)/)) pushTo(tokens, part.startsWith('@') ? 'tag' : 'plain', part);
    } else {
      const head = GHERKIN_HEAD.exec(line);
      const step = head === null ? GHERKIN_STEP.exec(line) : null;
      if (head !== null) {
        pushTo(tokens, 'plain', head[1] ?? '');
        pushTo(tokens, 'keyword', `${head[2]}${head[3]}`);
        pushTo(tokens, 'plain', head[4] ?? '');
      } else if (step !== null) {
        pushTo(tokens, 'plain', step[1] ?? '');
        pushTo(tokens, 'keyword', step[2] ?? '');
        gherkinInline(tokens, step[3] ?? '');
      } else {
        gherkinInline(tokens, line);
      }
    }
    lines.push(tokens);
  }
  return lines;
}

/** Split tokens at their line breaks; a line without text is an empty array. */
export function toLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    token.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== '') (lines[lines.length - 1] as Token[]).push({ type: token.type, text: part });
    });
  }
  return lines;
}

/** The lines of a file as tokens, line 1 first. */
export function highlight(text: string, language: Language): Token[][] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (language === 'gherkin') return tokenizeGherkin(normalized);
  if (language === 'ts') return toLines(tokenizeTs(normalized));
  return normalized.split('\n').map((line) => (line === '' ? [] : [{ type: 'plain', text: line }]));
}
