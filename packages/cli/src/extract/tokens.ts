/**
 * The tokens of a source, read without a compiler: words, punctuators,
 * strings, template literals, numbers and regular expressions, with the
 * comments apart. The function catalog (functions.ts) reads calls and bodies
 * through the mask of the characters that are code (codeMaskOf), so a call
 * written inside a string, a comment or a regular expression is not one.
 *
 * The published CLI reads the catalog with this and needs no dependency. The
 * flow of a function (what the map of the repository shows) is read with the
 * TypeScript compiler by packages/map-analysis instead.
 */
/** The source cannot be read as tokens (an unterminated template literal or comment). */
export class TokenizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenizeError';
  }
}

export interface FlowToken {
  type: 'word' | 'punct' | 'string' | 'template' | 'number' | 'regex';
  text: string;
  start: number;
  end: number;
  /** Whether a line break separates the token from the one before it. */
  newline: boolean;
}

export interface FlowComment {
  text: string;
  start: number;
  end: number;
}

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '**', '<<', '>>',
];

/** Keywords after which a `/` starts a regular expression, not a division. */
const BEFORE_EXPRESSION = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await',
]);

/** Whether a `/` after this token starts a regular expression (not a division, nor the `</` of a JSX closing tag). */
function regexAllowed(previous: FlowToken | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.type === 'word') return BEFORE_EXPRESSION.has(previous.text);
  if (previous.type === 'punct') return previous.text !== ')' && previous.text !== ']' && previous.text !== '<';
  return false;
}

/**
 * The tokens and the comments of a range of the source. The code inside the
 * `${...}` of a template literal is tokenized in place; the text parts of the
 * template are `template` tokens. A quote or a slash that does not close on
 * its line (the apostrophe of a JSX text, the `/>` of a JSX tag) is read as a
 * punctuator, so JSX does not stop the reading.
 */
export function tokenize(source: string, start: number, end: number): { tokens: FlowToken[]; comments: FlowComment[] } {
  const tokens: FlowToken[] = [];
  const comments: FlowComment[] = [];
  /** The brace depths at which the `${` of a template opened. */
  const templates: number[] = [];
  let depth = 0;
  let newline = false;
  const push = (type: FlowToken['type'], from: number, to: number) => {
    tokens.push({ type, text: source.slice(from, to), start: from, end: to, newline });
    newline = false;
  };
  /** Scan the text of a template from `from`: to the closing backtick, or into the next `${`. */
  const templateChunk = (from: number): { to: number; expression: boolean } => {
    for (let index = from; index < end; index += 1) {
      const char = source[index];
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '`') return { to: index + 1, expression: false };
      if (char === '$' && source[index + 1] === '{') return { to: index + 2, expression: true };
    }
    throw new TokenizeError('unterminated template literal');
  };
  let index = start;
  while (index < end) {
    const char = source[index] as string;
    if (char === '\n') {
      newline = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const stop = source.indexOf('\n', index);
      const to = stop === -1 || stop > end ? end : stop;
      comments.push({ text: source.slice(index, to), start: index, end: to });
      index = to;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const stop = source.indexOf('*/', index + 2);
      if (stop === -1 || stop + 2 > end) throw new TokenizeError('unterminated comment');
      comments.push({ text: source.slice(index, stop + 2), start: index, end: stop + 2 });
      if (source.slice(index, stop).includes('\n')) newline = true;
      index = stop + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let to = index + 1;
      while (to < end && source[to] !== char && source[to] !== '\n') {
        if (source[to] === '\\') to += 1;
        to += 1;
      }
      if (to >= end || source[to] !== char) {
        push('punct', index, index + 1);
        index += 1;
        continue;
      }
      push('string', index, to + 1);
      index = to + 1;
      continue;
    }
    if (char === '`') {
      const chunk = templateChunk(index + 1);
      push('template', index, chunk.to);
      if (chunk.expression) {
        templates.push(depth);
        depth += 1;
      }
      index = chunk.to;
      continue;
    }
    if (char === '}' && templates.length > 0 && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth -= 1;
      const chunk = templateChunk(index + 1);
      push('template', index, chunk.to);
      if (chunk.expression) {
        templates.push(depth);
        depth += 1;
      }
      index = chunk.to;
      continue;
    }
    if (char === '/' && regexAllowed(tokens[tokens.length - 1])) {
      let to = index + 1;
      let inClass = false;
      let closed = false;
      for (; to < end; to += 1) {
        const c = source[to];
        if (c === '\\') {
          to += 1;
          continue;
        }
        if (c === '\n') break;
        if (inClass) {
          if (c === ']') inClass = false;
        } else if (c === '[') inClass = true;
        else if (c === '/') {
          closed = true;
          break;
        }
      }
      if (closed) {
        to += 1;
        while (to < end && /[a-z]/i.test(source[to] as string)) to += 1;
        push('regex', index, to);
        index = to;
        continue;
      }
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let to = index + 1;
      while (to < end && /[0-9a-zA-Z_.]/.test(source[to] as string)) to += 1;
      push('number', index, to);
      index = to;
      continue;
    }
    if (/[\p{L}_$]/u.test(char)) {
      let to = index + 1;
      while (to < end && /[\p{L}\p{N}_$]/u.test(source[to] as string)) to += 1;
      push('word', index, to);
      index = to;
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, index));
    // `a ? .5 : b` is a conditional, not an optional chain.
    const text = punctuator === '?.' && /[0-9]/.test(source[index + 2] ?? '') ? '?' : (punctuator ?? char);
    if (text === '{') depth += 1;
    else if (text === '}') depth -= 1;
    push('punct', index, index + text.length);
    index += text.length;
  }
  return { tokens, comments };
}

/**
 * Which characters of a source are code (1) and which are inside a comment,
 * a string, a regular expression or the text of a template literal (0): the
 * mask the function catalog reads calls and bodies through. The code inside
 * `${...}` stays code.
 */
export function codeMaskOf(source: string): Uint8Array {
  const mask = new Uint8Array(source.length).fill(1);
  const { tokens, comments } = tokenize(source, 0, source.length);
  for (const range of [...comments, ...tokens.filter((token) => token.type === 'string' || token.type === 'regex' || token.type === 'template')]) {
    mask.fill(0, range.start, range.end);
  }
  return mask;
}
