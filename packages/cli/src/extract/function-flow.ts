/**
 * The flow inside one function, read from its body: which functions it calls
 * in which order, where it branches and on what condition, and where it
 * returns or throws. The provider map draws it like the steps of an
 * endpoint, so a reader can follow what a function does without opening the
 * file.
 *
 * Like the rest of the function catalog (functions.ts), the body is read from
 * the source text without a compiler. The statements are what the repository
 * writes: blocks, `if` / `else`, loops, `switch`, `try` / `catch` /
 * `finally`, `return`, `throw` and expression or declaration statements
 * ended by `;`. Inside a statement, the calls are taken in the order they
 * finish (`f(g(x))` calls g, then f). A call of a function of the catalog is
 * a box; so is a call of a method of a resolver, a store or a provider the
 * code holds (`consentResolver.recordConsent`), which the catalog cannot
 * resolve, when an interface of the roots declares that method. A condition, a loop header or a `case` labels the arrow into the
 * boxes it guards. A body that cannot be read this way (JSX text with an
 * apostrophe, for one) gives no flow.
 */
import { joinLines } from './prose.js';

/** One box of the flow of a function. */
export interface FunctionFlowNode {
  /** Unique within the flow (`n0`, `n1`, ...), in the order of the source. */
  id: string;
  /**
   * start: the function itself, with its parameters; condition: a boolean
   * guard or a short-circuit expression; call: a call of a
   * function of the catalog; dynamic: a call of a method of a resolver, a
   * store or a provider; return / throw: where the function ends; end: the
   * end of the body, reached without a return.
   */
  kind: 'start' | 'condition' | 'call' | 'dynamic' | 'return' | 'throw' | 'end';
  /** What the box says: the name of the callee, `receiver.method`, `return …`, `throw TokenError(InvalidClient)`. */
  label: string;
  /** For a call: the id of the card of the callee. */
  callee?: string;
  /** For a dynamic call: the member of the interface it calls (`ConsentResolver.recordConsent`). */
  member?: string;
  /** The comment right above the statement the box comes from: what the author says that line does. */
  note?: string;
  /** The line of the source the box comes from (1-based). */
  line: number;
}

/** An arrow of the flow of a function. */
export interface FunctionFlowEdge {
  from: string;
  to: string;
  /** The condition, loop header or case that leads along the arrow (`!client`, `else`, `case 'none'`, `catch`). */
  label?: string;
  /** flow: the next statement; branch: guarded by a condition; error: the way into a catch block. */
  kind: 'flow' | 'branch' | 'error';
}

export interface FunctionFlow {
  nodes: FunctionFlowNode[];
  edges: FunctionFlowEdge[];
}

/** What the flow of one function is built from. */
export interface FunctionFlowSource {
  /** The text of the whole file. */
  source: string;
  /** The range of the body, braces included. */
  body: { start: number; end: number };
  /** The name of the function (the label of the start box). */
  name: string;
  /** The text between the parentheses of the parameter list. */
  parameters: string;
  /** The id of the card a name the body calls refers to, or undefined for a name outside the catalog. */
  resolve(name: string): string | undefined;
  /**
   * The member of an interface a method call reaches (`ConsentResolver.recordConsent`),
   * from the chain of names before the method (`['input', 'store']`) and the
   * offset of the call; undefined for a method no interface of the roots
   * declares (a call into a framework, for one), which gets no box.
   */
  resolveMember?(receiver: readonly string[], method: string, offset: number): string | undefined;
}

/** The source cannot be read as statements; the caller falls back to no flow. */
export class FunctionFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionFlowError';
  }
}

// ---------------------------------------------------------------------------
// Tokens

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
    throw new FunctionFlowError('unterminated template literal');
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
      if (stop === -1 || stop + 2 > end) throw new FunctionFlowError('unterminated comment');
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

// ---------------------------------------------------------------------------
// Statements → flow

/** The names a `name(` may be that are not calls. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'yield', 'void', 'delete',
  'throw', 'else', 'do', 'in', 'of', 'instanceof', 'import', 'super', 'this', 'new', 'async', 'case', 'with',
]);

/** A receiver whose methods read or write the state of the provider: a resolver, a store, a provider of keys. */
const DYNAMIC_RECEIVER = /(?:Resolver|Store|Storage|Provider|resolver|store|storage)$/;

/** Words that continue an expression on the next line (no statement ends before them). */
const CONTINUATION_WORDS = new Set(['instanceof', 'in', 'of', 'as', 'satisfies', 'extends', 'keyof']);

interface Pending {
  from: string;
  label?: string;
  kind: FunctionFlowEdge['kind'];
}

/** Where control goes after a statement: on to the next one, out of a loop or switch (break), or back to the loop (continue). */
interface Out {
  pending: Pending[];
  breaks: Pending[];
  continues: Pending[];
}

interface CallSite {
  kind: 'call' | 'dynamic';
  label: string;
  callee?: string;
  member?: string;
  /** The offset of the call, for the line of the box. */
  offset: number;
  /** The token that closes the arguments: the calls run in this order. */
  order: number;
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

/** The 1-based line of an offset, from the offsets of the line breaks of the source. */
function lineAt(offset: number, lines: readonly number[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((lines[middle] as number) < offset) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

/** Collapse whitespace and cut a text to a width, with an ellipsis. */
function shorten(text: string, width = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** The text of a comment without its markers, on one line; empty for a directive (eslint, ts). */
function commentText(comment: string): string {
  const text = comment.startsWith('//')
    ? comment.slice(2)
    : joinLines(
        comment
          .replace(/^\/\*+/, '')
          .replace(/\*+\/$/, '')
          .split('\n')
          .map((line) => line.replace(/^\s*\*\s?/, '')),
      );
  const flat = text.replace(/\s+/g, ' ').trim();
  if (/^(eslint-|@ts-|prettier-ignore|istanbul )/.test(flat)) return '';
  return flat;
}

/** The parameter names of a parameter list (`c: any, { a, b }: X = {}` → `c, { a, b }`). */
export function parameterNames(parameters: string): string {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    let part = current.trim();
    current = '';
    if (part === '') return;
    part = part.replace(/^(?:public|private|protected|readonly)\s+/, '');
    // Up to the type annotation or the default value, outside brackets.
    let level = 0;
    let cut = part.length;
    for (let index = 0; index < part.length; index += 1) {
      const char = part[index] as string;
      if ('([{<'.includes(char)) level += 1;
      else if (')]}>'.includes(char)) level -= 1;
      else if (level === 0 && (char === ':' || char === '=' || (char === '?' && part[index + 1] === ':'))) {
        cut = index;
        break;
      }
    }
    names.push(part.slice(0, cut).replace(/\s+/g, ' ').trim());
  };
  for (const char of parameters) {
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) flush();
    else current += char;
  }
  flush();
  return names.filter((name) => name !== '').join(', ');
}

class FlowBuilder {
  readonly nodes: FunctionFlowNode[] = [];
  readonly edges: FunctionFlowEdge[] = [];
  private readonly tokens: FlowToken[];
  private readonly comments: FlowComment[];
  private readonly lines: number[] = [];
  private readonly matches = new Map<number, number>();
  private readonly exceptionSources: Pending[][] = [];

  constructor(private readonly input: FunctionFlowSource) {
    const { tokens, comments } = tokenize(input.source, input.body.start + 1, input.body.end - 1);
    this.tokens = tokens;
    this.comments = comments;
    for (let index = 0; index < input.source.length; index += 1) {
      if (input.source.charCodeAt(index) === 10) this.lines.push(index);
    }
    // Match every bracket once.
    const stack: number[] = [];
    tokens.forEach((token, index) => {
      if (token.type !== 'punct') return;
      if (OPEN.has(token.text)) stack.push(index);
      else if (CLOSE.has(token.text)) {
        const open = stack.pop();
        if (open === undefined) throw new FunctionFlowError(`unbalanced "${token.text}"`);
        const pair = (this.tokens[open] as FlowToken).text + token.text;
        if (pair !== '()' && pair !== '[]' && pair !== '{}') throw new FunctionFlowError(`mismatched "${pair}"`);
        this.matches.set(open, index);
      }
    });
    if (stack.length > 0) throw new FunctionFlowError('unbalanced brackets');
  }

  build(): FunctionFlow {
    const start = this.add({ kind: 'start', label: `${this.input.name}(${shorten(parameterNames(this.input.parameters), 70)})`, line: this.line(this.input.body.start) }, []);
    const out = this.statements(0, this.tokens.length, [{ from: start, kind: 'flow' }], this.input.body.start + 1);
    const open = [...out.pending, ...out.breaks, ...out.continues];
    if (open.length > 0) {
      this.add({ kind: 'end', label: 'end', line: this.line(this.input.body.end - 1) }, open);
    }
    return { nodes: this.nodes, edges: this.edges };
  }

  // ---- helpers

  private token(index: number): FlowToken | undefined {
    return this.tokens[index];
  }

  private is(index: number, text: string, type: FlowToken['type'] = 'punct'): boolean {
    const token = this.tokens[index];
    return token !== undefined && token.type === type && token.text === text;
  }

  private word(index: number, text: string): boolean {
    return this.is(index, text, 'word');
  }

  private close(open: number): number {
    const close = this.matches.get(open);
    if (close === undefined) throw new FunctionFlowError('no closing bracket');
    return close;
  }

  private line(offset: number): number {
    return lineAt(offset, this.lines);
  }

  private text(from: number, to: number): string {
    if (to <= from) return '';
    return this.input.source.slice((this.tokens[from] as FlowToken).start, (this.tokens[to - 1] as FlowToken).end);
  }

  private add(node: Omit<FunctionFlowNode, 'id'>, entry: readonly Pending[]): string {
    const id = `n${this.nodes.length}`;
    this.nodes.push({ id, ...node });
    for (const pending of entry) {
      const duplicate = this.edges.some(
        (edge) => edge.from === pending.from && edge.to === id && edge.label === pending.label && edge.kind === pending.kind,
      );
      if (duplicate) continue;
      this.edges.push(
        pending.label === undefined
          ? { from: pending.from, to: id, kind: pending.kind }
          : { from: pending.from, to: id, label: pending.label, kind: pending.kind },
      );
    }
    return id;
  }

  /** The note of a statement: the comments between the end of the previous statement and its first token. */
  private noteBefore(from: number, statement: number): string | undefined {
    const first = this.tokens[statement];
    if (first === undefined) return undefined;
    const source = this.input.source;
    // A comment on the line where the previous statement ended trails that statement.
    const trails = (comment: FlowComment) => source[from - 1] === ';' && !source.slice(from, comment.start).includes('\n');
    const texts = this.comments
      .filter((comment) => comment.start >= from && comment.end <= first.start && !trails(comment))
      .map((comment) => commentText(comment.text))
      .filter((text) => text !== '');
    return texts.length === 0 ? undefined : shorten(joinLines(texts), 220);
  }

  /** Arrows that carry a condition into the boxes it guards. */
  private label(entry: readonly Pending[], text: string, kind: FunctionFlowEdge['kind'] = 'branch'): Pending[] {
    // An arrow into a catch block stays an error arrow through the conditions inside the block.
    return entry.map((pending) => ({ from: pending.from, kind: pending.kind === 'error' ? 'error' : kind, label: combine(pending.label, text) }));
  }

  /** Chain boxes for the calls of a statement; the note goes on the first. */
  private chain(calls: readonly CallSite[], entry: Pending[], note: string | undefined): { pending: Pending[]; noted: boolean } {
    let pending = entry;
    let noted = false;
    for (const call of calls) {
      const node: Omit<FunctionFlowNode, 'id'> = { kind: call.kind, label: call.label, line: this.line(call.offset) };
      if (call.callee !== undefined) node.callee = call.callee;
      if (call.member !== undefined) node.member = call.member;
      if (note !== undefined && !noted) {
        node.note = note;
        noted = true;
      }
      pending = [{ from: this.add(node, pending), kind: 'flow' }];
      this.exceptionSources.at(-1)?.push(...pending);
    }
    return { pending, noted };
  }

  /** Preserve conditional evaluation of a statement's RHS, including short-circuit fallbacks. */
  private expression(from: number, to: number, entry: Pending[], note: string | undefined): { pending: Pending[]; noted: boolean } {
    if (this.is(to - 1, ';')) to -= 1;
    // A declaration or assignment evaluates its right-hand side.
    for (let cursor = from; cursor < to; cursor += 1) {
      if (OPEN.has(this.token(cursor)?.text ?? '')) { cursor = this.close(cursor); continue; }
      if (this.is(cursor, '=')) return this.expression(cursor + 1, to, entry, note);
    }
    while (this.is(from, '(') && this.close(from) === to - 1) { from += 1; to -= 1; }
    let question = -1;
    let colon = -1;
    let nested = 0;
    let logical = -1;
    const precedence: Record<string, number> = { '??': 1, '||': 1, '&&': 2 };
    for (let cursor = from; cursor < to; cursor += 1) {
      const token = this.token(cursor) as FlowToken;
      if (token.type !== 'punct') continue;
      if (OPEN.has(token.text)) { cursor = this.close(cursor); continue; }
      if (token.text === '?') {
        if (question < 0) question = cursor;
        nested += 1;
      } else if (token.text === ':' && question >= 0) {
        nested -= 1;
        if (nested === 0) { colon = cursor; break; }
      } else if (question < 0 && precedence[token.text] !== undefined && (logical < 0 || precedence[token.text]! <= precedence[(this.token(logical) as FlowToken).text]!)) logical = cursor;
    }
    const split = question >= 0 && colon >= 0 ? question : logical;
    if (split < 0) return this.chain(this.calls(from, to), entry, note);
    const left = this.expression(from, split, entry, note);
    const condition = this.add({ kind: 'condition', label: shorten(this.text(from, split)), line: this.line((this.token(from) as FlowToken).start) }, left.pending);
    const branch: Pending[] = [{ from: condition, kind: 'flow' }];
    if (split === question) {
      const yes = this.expression(question + 1, colon, this.label(branch, 'true'), left.noted ? undefined : note);
      const no = this.expression(colon + 1, to, this.label(branch, 'false'), left.noted ? undefined : note);
      return { pending: [...yes.pending, ...no.pending], noted: left.noted || yes.noted || no.noted };
    }
    const operator = (this.token(split) as FlowToken).text;
    const take = operator === '&&' ? 'true' : operator === '??' ? 'nullish' : 'false';
    const skip = operator === '&&' ? 'false' : operator === '??' ? 'defined' : 'true';
    const right = this.expression(split + 1, to, this.label(branch, take), left.noted ? undefined : note);
    return { pending: [...right.pending, ...this.label(branch, skip)], noted: left.noted || right.noted };
  }

  /** Evaluate a boolean guard without reconnecting a short-circuited result to both outcomes. */
  private test(from: number, to: number, entry: Pending[], note: string | undefined): { yes: Pending[]; no: Pending[]; noted: boolean } {
    while (this.is(from, '(') && this.close(from) === to - 1) { from += 1; to -= 1; }
    let split = -1;
    for (let cursor = from; cursor < to; cursor += 1) {
      const token = this.token(cursor) as FlowToken;
      if (token.type !== 'punct') continue;
      if (OPEN.has(token.text)) { cursor = this.close(cursor); continue; }
      // A ternary or nullish expression needs its value evaluated as a whole.
      if (token.text === '?' || token.text === '??') { split = -1; break; }
      if (token.text === '||' || (token.text === '&&' && !this.is(split, '||'))) split = cursor;
    }
    if (split >= 0) {
      const left = this.test(from, split, entry, note);
      const and = this.is(split, '&&');
      const right = this.test(split + 1, to, and ? left.yes : left.no, left.noted ? undefined : note);
      return { yes: and ? right.yes : [...left.yes, ...right.yes], no: and ? [...left.no, ...right.no] : right.no, noted: left.noted || right.noted };
    }
    const value = this.expression(from, to, entry, note);
    const id = this.add({ kind: 'condition', label: shorten(this.text(from, to)), line: this.line((this.token(from) as FlowToken).start) }, value.pending);
    const branch: Pending[] = [{ from: id, kind: 'flow' }];
    return { yes: this.label(branch, 'true'), no: this.label(branch, 'false'), noted: value.noted };
  }

  /** The calls between two tokens, in the order they finish. */
  private calls(from: number, to: number): CallSite[] {
    const sites: CallSite[] = [];
    for (let index = from; index < to; index += 1) {
      const token = this.tokens[index] as FlowToken;
      if (token.type !== 'word' || NOT_A_CALL.has(token.text)) continue;
      let open = index + 1;
      if (this.is(open, '?.')) open += 1;
      if (!this.is(open, '(') || open >= to) continue;
      const previous = this.tokens[index - 1];
      if (previous?.type === 'word' && (previous.text === 'function' || previous.text === 'new')) continue;
      if (previous?.type === 'punct' && previous.text === '*') continue;
      const order = this.close(open);
      if (this.isMethodDefinition(index, order)) {
        index = this.methodEnd(order);
        continue;
      }
      if (previous?.type === 'punct' && (previous.text === '.' || previous.text === '?.')) {
        const receiver = this.receiverOf(index - 2);
        const last = receiver[receiver.length - 1];
        if (last !== undefined && DYNAMIC_RECEIVER.test(last)) {
          const member = this.input.resolveMember?.(receiver, token.text, token.start);
          if (member !== undefined) sites.push({ kind: 'dynamic', label: `${last}.${token.text}`, member, offset: token.start, order });
        }
        continue;
      }
      const callee = this.input.resolve(token.text);
      if (callee !== undefined) sites.push({ kind: 'call', label: token.text, callee, offset: token.start, order });
    }
    return sites.sort((a, b) => a.order - b.order);
  }

  /** The chain of names that ends at the token `index` (`input.store` → ['input', 'store']); empty when it is not a name. */
  private receiverOf(index: number): string[] {
    const chain: string[] = [];
    let cursor = index;
    while (this.token(cursor)?.type === 'word') {
      chain.unshift((this.tokens[cursor] as FlowToken).text);
      if (this.is(cursor - 1, '.') || this.is(cursor - 1, '?.')) cursor -= 2;
      else break;
    }
    return chain;
  }

  /**
   * Whether `name(...)` at `index` defines a method of an object literal or
   * a class (`{ async find(code) { ... } }`) instead of calling it: it follows
   * `{`, `,` or a modifier and its parameter list is followed by a body or a
   * return type.
   */
  private isMethodDefinition(index: number, close: number): boolean {
    const previous = this.tokens[index - 1];
    const after = this.tokens[close + 1];
    const opensMember =
      previous === undefined ||
      (previous.type === 'punct' && (previous.text === '{' || previous.text === ',' || previous.text === '*')) ||
      (previous.type === 'word' && ['async', 'get', 'set', 'static', 'public', 'private', 'protected'].includes(previous.text));
    if (!opensMember || after?.type !== 'punct') return false;
    if (after.text === '{') return true;
    // `find(code): Promise<X> {` — the `:` of a ternary (`? f(x) : g(y)`) never follows `{` or `,`.
    return after.text === ':';
  }

  /** The last token of the body of a method whose parameter list closes at `close`. */
  private methodEnd(close: number): number {
    for (let cursor = close + 1; cursor < this.tokens.length; cursor += 1) {
      const token = this.tokens[cursor] as FlowToken;
      if (token.type !== 'punct') continue;
      if (token.text === '(' || token.text === '[') {
        cursor = this.close(cursor);
        continue;
      }
      if (token.text === '{') {
        const end = this.close(cursor);
        const next = this.tokens[end + 1];
        if (next?.type === 'punct' && ['|', '&', '[', '>', '{'].includes(next.text)) {
          cursor = end;
          continue;
        }
        return end;
      }
      if (token.text === ',' || token.text === ';' || token.text === '}') return cursor - 1;
    }
    return this.tokens.length - 1;
  }

  // ---- statements

  /** The statements between two tokens (a block's inside), run one after another. */
  private statements(from: number, to: number, entry: Pending[], after: number): Out {
    let pending = entry;
    const breaks: Pending[] = [];
    const continues: Pending[] = [];
    let index = from;
    let previousEnd = after;
    while (index < to && pending.length > 0) {
      const note = this.noteBefore(previousEnd, index);
      const result = this.statement(index, to, pending, note);
      if (result.next <= index) throw new FunctionFlowError('no progress');
      previousEnd = (this.tokens[result.next - 1] as FlowToken).end;
      index = result.next;
      pending = result.out.pending;
      breaks.push(...result.out.breaks);
      continues.push(...result.out.continues);
    }
    return { pending, breaks, continues };
  }

  private statement(index: number, limit: number, entry: Pending[], note: string | undefined): { next: number; out: Out } {
    const token = this.tokens[index] as FlowToken;
    const pass = (next: number): { next: number; out: Out } => ({ next, out: { pending: entry, breaks: [], continues: [] } });
    if (token.type === 'punct' && token.text === '{') {
      const close = this.close(index);
      return { next: close + 1, out: this.statements(index + 1, close, entry, token.end) };
    }
    if (token.type === 'punct' && token.text === ';') return pass(index + 1);
    if (token.type === 'word') {
      switch (token.text) {
        case 'if':
          return this.ifStatement(index, limit, entry, note);
        case 'for':
        case 'while':
          return this.loop(index, limit, entry, note);
        case 'do':
          return this.doWhile(index, limit, entry, note);
        case 'switch':
          return this.switchStatement(index, entry, note);
        case 'try':
          return this.tryStatement(index, entry);
        case 'return':
        case 'throw':
          return this.exit(index, limit, entry, note);
        case 'break': {
          const next = this.end(index + 1, limit);
          return { next, out: { pending: [], breaks: entry, continues: [] } };
        }
        case 'continue': {
          const next = this.end(index + 1, limit);
          return { next, out: { pending: [], breaks: [], continues: entry } };
        }
        case 'function':
        case 'class':
          return pass(this.skipDeclaration(index, limit));
        case 'async':
          if (this.word(index + 1, 'function')) return pass(this.skipDeclaration(index + 1, limit));
          break;
        default:
          // `label:` before a loop or a block.
          if (this.is(index + 1, ':') && !this.word(index, 'default')) {
            return this.statement(index + 2, limit, entry, note);
          }
      }
    }
    const next = this.end(index, limit);
    const { pending } = this.expression(index, next, entry, note);
    return { next, out: { pending, breaks: [], continues: [] } };
  }

  /**
   * The token after the end of a simple statement starting at `index`: past
   * its `;`, or at the `}` that closes the block around it, or where a line
   * break ends it (automatic semicolon insertion).
   */
  private end(index: number, limit: number): number {
    for (let cursor = index; cursor < limit; cursor += 1) {
      const token = this.tokens[cursor] as FlowToken;
      if (token.type === 'punct') {
        if (OPEN.has(token.text)) {
          cursor = this.close(cursor);
          continue;
        }
        if (token.text === ';') return cursor + 1;
        if (token.text === '}' || token.text === ')' || token.text === ']') return cursor;
      }
      if (cursor > index && token.newline && this.endsBefore(cursor)) return cursor;
    }
    return limit;
  }

  /** Whether a line break before the token at `cursor` ends the statement before it. */
  private endsBefore(cursor: number): boolean {
    const token = this.tokens[cursor] as FlowToken;
    const previous = this.tokens[cursor - 1] as FlowToken;
    if (token.type !== 'word' || CONTINUATION_WORDS.has(token.text)) return false;
    if (previous.type === 'punct') return previous.text === ')' || previous.text === ']' || previous.text === '}' || previous.text === '++' || previous.text === '--';
    if (previous.type === 'word') return !BEFORE_EXPRESSION.has(previous.text) && previous.text !== 'export' && previous.text !== 'const' && previous.text !== 'let' && previous.text !== 'var';
    return true;
  }

  /** Skip a declaration nested in the body (a function or a class): its calls do not run here. */
  private skipDeclaration(index: number, limit: number): number {
    for (let cursor = index; cursor < limit; cursor += 1) {
      const token = this.tokens[cursor] as FlowToken;
      if (token.type !== 'punct') continue;
      if (token.text === '(' || token.text === '[') {
        cursor = this.close(cursor);
        continue;
      }
      if (token.text === '{') {
        const close = this.close(cursor);
        // A brace group of a return type is followed by more of the type.
        const next = this.tokens[close + 1];
        if (next?.type === 'punct' && ['|', '&', '[', '>', '{', ')', ',', '='].includes(next.text)) {
          cursor = close;
          continue;
        }
        return close + 1;
      }
    }
    throw new FunctionFlowError('a nested declaration without a body');
  }

  private ifStatement(index: number, limit: number, entry: Pending[], note: string | undefined): { next: number; out: Out } {
    if (!this.is(index + 1, '(')) throw new FunctionFlowError('if without a condition');
    const close = this.close(index + 1);
    const condition = this.test(index + 2, close, entry, note);
    const then = this.statement(close + 1, limit, condition.yes, condition.noted ? undefined : note);
    let next = then.next;
    let otherwise: Out = { pending: condition.no, breaks: [], continues: [] };
    if (this.word(next, 'else')) {
      const result = this.statement(next + 1, limit, condition.no, undefined);
      next = result.next;
      otherwise = result.out;
    }
    return {
      next,
      out: {
        pending: [...then.out.pending, ...otherwise.pending],
        breaks: [...then.out.breaks, ...otherwise.breaks],
        continues: [...then.out.continues, ...otherwise.continues],
      },
    };
  }

  private loop(index: number, limit: number, entry: Pending[], note: string | undefined): { next: number; out: Out } {
    if (!this.is(index + 1, '(')) throw new FunctionFlowError('loop without a header');
    const close = this.close(index + 1);
    const header = this.chain(this.calls(index + 2, close), entry, note);
    const text = shorten(`${(this.tokens[index] as FlowToken).text} (${this.text(index + 2, close)})`);
    const before = this.nodes.length;
    const body = this.statement(close + 1, limit, this.label(header.pending, text), header.noted ? undefined : note);
    if (this.nodes.length === before && body.out.pending.length > 0) {
      return { next: body.next, out: { pending: header.pending, breaks: [], continues: [] } };
    }
    return {
      next: body.next,
      out: { pending: [...header.pending, ...body.out.pending, ...body.out.breaks, ...body.out.continues], breaks: [], continues: [] },
    };
  }

  private doWhile(index: number, limit: number, entry: Pending[], note: string | undefined): { next: number; out: Out } {
    const body = this.statement(index + 1, limit, this.label(entry, 'do'), note);
    let next = body.next;
    let pending = [...body.out.pending, ...body.out.continues];
    if (this.word(next, 'while') && this.is(next + 1, '(')) {
      const close = this.close(next + 1);
      pending = this.chain(this.calls(next + 2, close), pending, undefined).pending;
      next = close + 1;
      if (this.is(next, ';')) next += 1;
    }
    return { next, out: { pending: [...pending, ...body.out.breaks], breaks: [], continues: [] } };
  }

  private switchStatement(index: number, entry: Pending[], note: string | undefined): { next: number; out: Out } {
    if (!this.is(index + 1, '(')) throw new FunctionFlowError('switch without a discriminant');
    const close = this.close(index + 1);
    const discriminant = this.chain(this.calls(index + 2, close), entry, note);
    if (!this.is(close + 1, '{')) throw new FunctionFlowError('switch without a body');
    const bodyOpen = close + 1;
    const bodyClose = this.close(bodyOpen);
    // The clauses: each starts at a `case` or `default` of the body's own level.
    const starts: number[] = [];
    for (let cursor = bodyOpen + 1; cursor < bodyClose; cursor += 1) {
      const token = this.tokens[cursor] as FlowToken;
      if (token.type === 'punct' && OPEN.has(token.text)) {
        cursor = this.close(cursor);
        continue;
      }
      if (token.type === 'word' && (token.text === 'case' || token.text === 'default')) starts.push(cursor);
    }
    const breaks: Pending[] = [];
    const continues: Pending[] = [];
    let fallthrough: Pending[] = [];
    let hasDefault = false;
    starts.forEach((start, position) => {
      const stop = starts[position + 1] ?? bodyClose;
      let colon = start + 1;
      while (colon < stop && !this.is(colon, ':')) {
        const token = this.tokens[colon] as FlowToken;
        colon = token.type === 'punct' && OPEN.has(token.text) ? this.close(colon) + 1 : colon + 1;
      }
      const isDefault = this.word(start, 'default');
      hasDefault ||= isDefault;
      const text = isDefault ? 'default' : shorten(`case ${this.text(start + 1, colon)}`);
      const clauseEntry = [...this.label(discriminant.pending, text), ...fallthrough];
      const out = this.statements(colon + 1, stop, clauseEntry, (this.tokens[colon] as FlowToken).end);
      breaks.push(...out.breaks);
      continues.push(...out.continues);
      fallthrough = out.pending;
    });
    const pending = [...breaks, ...fallthrough, ...(hasDefault ? [] : this.label(discriminant.pending, 'default'))];
    return { next: bodyClose + 1, out: { pending, breaks: [], continues } };
  }

  private tryStatement(index: number, entry: Pending[]): { next: number; out: Out } {
    if (!this.is(index + 1, '{')) throw new FunctionFlowError('try without a block');
    const tryClose = this.close(index + 1);
    const sources: Pending[] = [];
    this.exceptionSources.push(sources);
    const attempt = this.statements(index + 2, tryClose, entry, (this.tokens[index + 1] as FlowToken).end);
    this.exceptionSources.pop();
    let next = tryClose + 1;
    let pending = attempt.pending;
    const breaks = [...attempt.breaks];
    const continues = [...attempt.continues];
    if (this.word(next, 'catch')) {
      let open = next + 1;
      if (this.is(open, '(')) open = this.close(open) + 1;
      if (!this.is(open, '{')) throw new FunctionFlowError('catch without a block');
      const close = this.close(open);
      const handler = this.statements(open + 1, close, this.label(sources.length > 0 ? sources : entry, 'catch', 'error'), (this.tokens[open] as FlowToken).end);
      pending = [...pending, ...handler.pending];
      breaks.push(...handler.breaks);
      continues.push(...handler.continues);
      next = close + 1;
    } else {
      this.exceptionSources.at(-1)?.push(...sources);
    }
    if (this.word(next, 'finally') && this.is(next + 1, '{')) {
      const close = this.close(next + 1);
      const final = this.statements(next + 2, close, pending, (this.tokens[next + 1] as FlowToken).end);
      pending = final.pending;
      breaks.push(...final.breaks);
      continues.push(...final.continues);
      next = close + 1;
    }
    return { next, out: { pending, breaks, continues } };
  }

  private exit(index: number, limit: number, entry: Pending[], note: string | undefined): { next: number; out: Out } {
    const keyword = (this.tokens[index] as FlowToken).text as 'return' | 'throw';
    const bareReturn = keyword === 'return' && (this.token(index + 1)?.newline ?? false);
    const next = bareReturn ? index + 1 : this.end(index + 1, limit);
    const expressionEnd = this.is(next - 1, ';') ? next - 1 : next;
    const { pending, noted } = this.expression(index + 1, expressionEnd, entry, note);
    const label = keyword === 'throw' ? this.describeThrow(index + 1, expressionEnd) : this.describeReturn(index + 1, expressionEnd);
    const node: Omit<FunctionFlowNode, 'id'> = { kind: keyword, label, line: this.line((this.tokens[index] as FlowToken).start) };
    if (note !== undefined && !noted) node.note = note;
    const id = this.add(node, pending);
    if (keyword === 'throw') this.exceptionSources.at(-1)?.push({ from: id, kind: 'flow' });
    return { next, out: { pending: [], breaks: [], continues: [] } };
  }

  /** `new TokenError(TokenErrorCode.InvalidClient, ...)` → `throw TokenError(InvalidClient)`. */
  private describeThrow(from: number, to: number): string {
    if (this.word(from, 'new') && this.token(from + 1)?.type === 'word' && this.is(from + 2, '(')) {
      const name = (this.tokens[from + 1] as FlowToken).text;
      const first = this.token(from + 3);
      let code: string | undefined;
      if (first?.type === 'word' && this.is(from + 4, '.') && this.token(from + 5)?.type === 'word') code = (this.tokens[from + 5] as FlowToken).text;
      else if (first?.type === 'string') code = first.text.slice(1, -1);
      return `throw ${name}${code === undefined ? '' : `(${code})`}`;
    }
    const call = this.callShape(from, to);
    return `throw ${call ?? shorten(this.text(from, to), 50)}`;
  }

  /** `return { a, b: c }` → `return { a, b }`; `return build(x)` → `return build(…)`. */
  private describeReturn(from: number, to: number): string {
    if (from >= to) return 'return';
    let start = from;
    if (this.word(start, 'await')) start += 1;
    if (this.is(start, '{') && this.close(start) === to - 1) {
      const keys: string[] = [];
      let expectKey = true;
      for (let cursor = start + 1; cursor < to - 1; cursor += 1) {
        const token = this.tokens[cursor] as FlowToken;
        if (token.type === 'punct' && OPEN.has(token.text)) {
          cursor = this.close(cursor);
          continue;
        }
        if (token.type === 'punct' && token.text === ',') {
          expectKey = true;
          continue;
        }
        if (expectKey && token.type === 'punct' && token.text === '...') {
          const spread = this.token(cursor + 1);
          if (spread?.type === 'word') keys.push(`...${spread.text}`);
          expectKey = false;
          continue;
        }
        if (expectKey && (token.type === 'word' || token.type === 'string')) {
          keys.push(token.type === 'string' ? token.text.slice(1, -1) : token.text);
          expectKey = false;
        }
      }
      return shorten(`return { ${keys.join(', ')} }`, 70);
    }
    const call = this.callShape(start, to);
    return `return ${call ?? shorten(this.text(start, to), 50)}`;
  }

  /** `name(...)` or `new Name(...)` spanning the whole range, as `name(…)`; undefined otherwise. */
  private callShape(from: number, to: number): string | undefined {
    let start = from;
    let prefix = '';
    if (this.word(start, 'new')) {
      prefix = 'new ';
      start += 1;
    }
    // A dotted callee: a.b.c(...)
    let cursor = start;
    const parts: string[] = [];
    while (this.token(cursor)?.type === 'word') {
      parts.push((this.tokens[cursor] as FlowToken).text);
      if (this.is(cursor + 1, '.') || this.is(cursor + 1, '?.')) cursor += 2;
      else break;
    }
    if (parts.length === 0 || !this.is(cursor + 1, '(')) return undefined;
    if (this.close(cursor + 1) !== to - 1) return undefined;
    const args = to - 1 > cursor + 2 ? '…' : '';
    return `${prefix}${parts.join('.')}(${args})`;
  }
}

/** The label of an arrow that passes two conditions: `else` then `b` reads `else if b`. */
function combine(previous: string | undefined, next: string): string {
  if (previous === undefined) return next;
  if (previous === 'else' && next !== 'else') return `else if ${next}`;
  return `${previous} › ${next}`;
}

/**
 * The flow of a function (see the module comment), or undefined when its body
 * cannot be read as statements.
 */
export function buildFunctionFlow(input: FunctionFlowSource): FunctionFlow | undefined {
  try {
    return new FlowBuilder(input).build();
  } catch (error) {
    if (error instanceof FunctionFlowError) return undefined;
    throw error;
  }
}
