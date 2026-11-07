/**
 * The test cases of a file of test code, read with the syntax tree of the
 * compiler the map reads the code with: no test runs.
 *
 * - The tests are the calls of `it` and `test` (with `.skip`, `.only`,
 *   `.todo`, `.each(...)`, ... and Playwright's `test.fixme`) inside the calls
 *   of `describe` (and `test.describe`), with the names of the blocks they
 *   are in as their path. A test written in a loop or with `.each` keeps the
 *   template of its title (`should reject %s`).
 * - The comments right above a test give what its author says: the sections
 *   of the specifications it cites (`// RFC 6749 §5.2: ...`), its Japanese
 *   name (`// ja: ...`), an id (`// @test-id ...`), aspects
 *   (`// @aspect boundary`) and subjects (`// @subject <id>`).
 * - Its expectations are the `expect(...)` chains of its body (words.ts).
 * - Its requests are the requests its body sends, or the functions of the
 *   same file its body calls send: `app.request(url, init)`, `fetch()`,
 *   `request.get()` / `.post()` of Playwright, `page.goto()`, a `Request`
 *   handed to a Route Handler, and the URL `toHaveURL()` expects. The path of
 *   the URL is its fixed part (`${TEST_ISSUER}/token` → `/token`).
 * - Its subjects are the functions of the catalog its describe blocks name
 *   (through the imports of the file, by the types: `describe` names the
 *   function as the README asks), the functions of the catalog its body
 *   calls, the endpoints its requests reach, and what its author declares.
 */
import {
  any,
  endLine,
  getLeadingCommentRanges,
  is,
  nameOf,
  startLine,
  stringOf,
  SyntaxKind,
  textOf,
  unwrap,
  walk,
  type Node,
  type SourceFile,
} from '@maronn-openid-connect/map-analysis';
import type { Assertion, RequestShape, Subject } from './model.js';
import { plainValue, sayExpectation, type Expectation, type Value } from './words.js';

/** What a test of the code is before the catalog decides its kind, its aspects and its id. */
export interface CodeTest {
  title: string;
  path: string[];
  lines: [number, number];
  /** What the comments above it say. */
  comments: TestComments;
  /** The expectations, in words, and as read (for the outcome and the errors). */
  assertions: Assertion[];
  expectations: Expectation[];
  requests: RequestShape[];
  /** The functions of the catalog its describe blocks name, outermost first. */
  described: string[];
  /** For each block of its path, the function of the catalog its name names (the id salts the test id: two modules with functions of one name keep their tests apart). */
  pathIds: Array<string | undefined>;
  /** The functions of the catalog its body calls in what it checks: inside an `expect(...)`, or to compute a value an expectation checks (the calls that only arrange state are left out). */
  called: string[];
  /** The endpoints it reaches other than by the path of a request: the Route Handler (Next.js) it calls, the page it expects to be at. */
  endpoints: string[];
  /** The URLs its expectations expect a page to be at (`toHaveURL`), as paths. */
  urls: string[];
  skipped: boolean;
  /** The text of its body, for the diff (a body that changed without its expectations). */
  body: string;
}

export interface TestComments {
  spec: string[];
  ja?: string;
  id?: string;
  aspects: string[];
  subjects: string[];
}

/** What reading a file needs from the catalog. */
export interface CodeReadOptions {
  /** The function of the catalog an imported name refers to, by the types (undefined for none). */
  importTarget(name: Node): string | undefined;
  /** The endpoint a path is (`/token` → `token`), or undefined. */
  endpointOfPath(path: string): string | undefined;
  /** The endpoint whose route module (Next.js) a function of the catalog is in. */
  endpointOfFunction(id: string): string | undefined;
  /** The specification references of a text (the catalog's normalization). */
  specReferencesOf(text: string): string[];
  /** The literal values of enum members (`TokenErrorCode.InvalidClient` → `invalid_client`), by the types. */
  constantsOf?(nodes: readonly Node[]): ReadonlyMap<Node, string>;
  /** The Japanese of an expectation's phrase with its holes, from the translation table. */
  translate?(phrase: string, holes: readonly string[]): string | undefined;
}

const DESCRIBE = new Set(['describe', 'suite']);
const TEST = new Set(['it', 'test']);
/** The modifiers of a test or a block that only change when it runs. */
const MODIFIERS = new Set(['only', 'concurrent', 'sequential', 'serial', 'parallel', 'shuffle', 'fails', 'fail', 'slow', 'each', 'for', 'skipIf', 'runIf', 'extend', 'scoped']);
/** The modifiers that skip it. */
const SKIPS = new Set(['skip', 'todo', 'fixme']);
/** What a call of `test.` is that is not a test. */
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'use', 'step', 'info', 'setTimeout', 'configure', 'extend', 'expect']);

/** A callee as a root identifier and the names after it (`describe.skip.each(...)` → describe, [skip, each]). */
function calleeChain(node: Node): { root: string; names: string[] } | undefined {
  const names: string[] = [];
  let current = unwrap(node);
  for (;;) {
    if (is(current, SyntaxKind.Identifier)) return { root: current['text'] as string, names: names.reverse() };
    if (is(current, SyntaxKind.PropertyAccessExpression)) {
      names.push(nameOf(current['name']) ?? '');
      current = unwrap(current['expression'] as Node);
      continue;
    }
    // `describe.each(table)(name, fn)`: the callee is itself a call.
    if (is(current, SyntaxKind.CallExpression)) {
      current = unwrap(current['expression'] as Node);
      continue;
    }
    return undefined;
  }
}

/** What a call is in a test file: a block of tests, a test, or neither. */
function testCallOf(call: Node): { kind: 'describe' | 'test'; skipped: boolean } | undefined {
  const chain = calleeChain(any(call)['expression'] as Node);
  if (chain === undefined) return undefined;
  const { root, names } = chain;
  if (names.some((name) => HOOKS.has(name))) return undefined;
  // Playwright: test.describe(...), test.describe.serial(...).
  const playwrightBlock = root === 'test' && names[0] === 'describe';
  if (DESCRIBE.has(root) || playwrightBlock) {
    const rest = playwrightBlock ? names.slice(1) : names;
    if (!rest.every((name) => MODIFIERS.has(name) || SKIPS.has(name))) return undefined;
    return { kind: 'describe', skipped: rest.some((name) => SKIPS.has(name)) };
  }
  if (TEST.has(root)) {
    if (!names.every((name) => MODIFIERS.has(name) || SKIPS.has(name))) return undefined;
    return { kind: 'test', skipped: names.some((name) => SKIPS.has(name)) };
  }
  return undefined;
}

/** The text of a title: a string, a template (its substitutions kept as code), `fn.name`, or the code. */
function titleOf(file: SourceFile, node: Node | undefined): string {
  if (node === undefined) return '';
  const literal = stringOf(node);
  if (literal !== undefined) return literal;
  const value = unwrap(node);
  if (is(value, SyntaxKind.TemplateExpression)) return textOf(file, value).slice(1, -1);
  if (is(value, SyntaxKind.PropertyAccessExpression) && nameOf(value['name']) === 'name') return textOf(file, value['expression'] as Node);
  if (is(value, SyntaxKind.Identifier)) return value['text'] as string;
  return textOf(file, value);
}

/** The function a test or a block runs: its last argument that is a function. */
function callbackOf(call: Node): Node | undefined {
  const args = (any(call)['arguments'] as Node[] | undefined) ?? [];
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = unwrap(args[index] as Node);
    if (is(arg, SyntaxKind.ArrowFunction) || is(arg, SyntaxKind.FunctionExpression)) return arg;
  }
  return undefined;
}

/** The statements of the body of a function. */
function statementsOf(fn: Node | undefined): Node[] {
  if (fn === undefined) return [];
  const body = any(fn)['body'] as Node | undefined;
  if (body === undefined) return [];
  return is(body, SyntaxKind.Block) ? ((body['statements'] as Node[]) ?? []) : [];
}

/** The comments right above a node (its leading comments), as their text without the comment marks. */
export function leadingComments(file: SourceFile, node: Node): string[] {
  const ranges = getLeadingCommentRanges(file.text, node.pos) ?? [];
  return ranges.map((range) =>
    file.text
      .slice(range.pos, range.end)
      .replace(/^\/\/\s?/, '')
      .replace(/^\/\*+\s?|\s*\*+\/$/g, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
      .join('\n'),
  );
}

/** What the comments above a test say (see the module comment). */
export function readComments(comments: readonly string[], specReferencesOf: (text: string) => string[]): TestComments {
  const read: TestComments = { spec: [], aspects: [], subjects: [] };
  for (const comment of comments) {
    for (const line of comment.split('\n')) {
      const trimmed = line.trim();
      const ja = /^ja:\s*(.+)$/.exec(trimmed);
      if (ja) {
        read.ja = (ja[1] as string).trim();
        continue;
      }
      const tag = /^@(test-id|aspect|subject)\s+(.+)$/.exec(trimmed);
      if (tag) {
        const values = (tag[2] as string).split(/[\s,]+/).filter((value) => value !== '');
        if (tag[1] === 'test-id') read.id = values[0];
        else if (tag[1] === 'aspect') read.aspects.push(...values);
        else read.subjects.push(...values);
        continue;
      }
      for (const reference of specReferencesOf(trimmed)) if (!read.spec.includes(reference)) read.spec.push(reference);
    }
  }
  return read;
}

/** A value of an expectation or a request as written (words.ts); an enum member is the value the types give it. */
export function valueOf(file: SourceFile, node: Node | undefined, constants: ReadonlyMap<Node, string> = new Map(), bound: ReadonlyMap<string, Value> = new Map()): Value {
  if (node === undefined) return { kind: 'undefined' };
  const value = unwrap(node);
  const literal = stringOf(value);
  if (literal !== undefined) return { kind: 'string', value: literal };
  const constant = constants.get(value);
  if (constant !== undefined) return /^-?\d+(\.\d+)?$/.test(constant) ? { kind: 'number', value: Number(constant) } : { kind: 'string', value: constant };
  switch (value.kind) {
    case SyntaxKind.NumericLiteral:
      return { kind: 'number', value: Number(any(value)['text']) };
    case SyntaxKind.TrueKeyword:
      return { kind: 'boolean', value: true };
    case SyntaxKind.FalseKeyword:
      return { kind: 'boolean', value: false };
    case SyntaxKind.NullKeyword:
      return { kind: 'null' };
    case SyntaxKind.RegularExpressionLiteral: {
      const text = any(value)['text'] as string;
      return { kind: 'regexp', source: text.slice(1, text.lastIndexOf('/')) };
    }
    case SyntaxKind.PrefixUnaryExpression: {
      const operand = unwrap(any(value)['operand'] as Node);
      if (any(value)['operator'] === SyntaxKind.MinusToken && is(operand, SyntaxKind.NumericLiteral)) return { kind: 'number', value: -Number(operand['text']) };
      break;
    }
    case SyntaxKind.Identifier: {
      const name = any(value)['text'] as string;
      if (name === 'undefined') return { kind: 'undefined' };
      // A parameter of a helper of the file, bound to what the test handed it.
      const known = bound.get(name);
      if (known !== undefined) return known;
      break;
    }
    case SyntaxKind.ObjectLiteralExpression: {
      const entries: Array<[string, Value]> = [];
      for (const property of (any(value)['properties'] as Node[]) ?? []) {
        if (is(property, SyntaxKind.PropertyAssignment)) {
          const key = nameOf(property['name'] as Node);
          if (key === undefined) return { kind: 'code', code: textOf(file, value) };
          entries.push([key, valueOf(file, property['initializer'] as Node, constants, bound)]);
        } else if (is(property, SyntaxKind.ShorthandPropertyAssignment)) {
          const key = nameOf(property['name'] as Node) ?? '';
          entries.push([key, { kind: 'code', code: key }]);
        } else {
          return { kind: 'code', code: textOf(file, value) };
        }
      }
      return { kind: 'object', entries };
    }
    case SyntaxKind.ArrayLiteralExpression:
      return { kind: 'array', items: ((any(value)['elements'] as Node[]) ?? []).map((element) => valueOf(file, element, constants, bound)) };
  }
  return { kind: 'code', code: textOf(file, value) };
}

/** An `expect(...)` chain a call ends: the matcher, `.not`, `.resolves`, `.rejects`, and the actual (undefined for another call). */
function expectationOf(file: SourceFile, call: Node, constants: ReadonlyMap<Node, string>, bound: ReadonlyMap<string, Value> = new Map()): (Expectation & { actualNode: Node }) | undefined {
  const callee = unwrap(any(call)['expression'] as Node);
  if (!is(callee, SyntaxKind.PropertyAccessExpression)) return undefined;
  const matcher = nameOf(callee['name']) ?? '';
  if (!/^to[A-Z]/.test(matcher)) return undefined;
  let negated = false;
  let mode: Expectation['mode'];
  let current = unwrap(callee['expression'] as Node);
  for (;;) {
    if (is(current, SyntaxKind.PropertyAccessExpression)) {
      const name = nameOf(current['name']);
      if (name === 'not') negated = !negated;
      else if (name === 'resolves' || name === 'rejects') mode = name;
      else return undefined;
      current = unwrap(current['expression'] as Node);
      continue;
    }
    break;
  }
  if (!is(current, SyntaxKind.CallExpression)) return undefined;
  const chain = calleeChain(current['expression'] as Node);
  if (chain === undefined || chain.root !== 'expect' || chain.names.some((name) => name !== 'soft' && name !== 'poll')) return undefined;
  const actual = (current['arguments'] as Node[] | undefined)?.[0];
  if (actual === undefined) return undefined;
  const args = ((any(call)['arguments'] as Node[]) ?? []).map((arg) => valueOf(file, arg, constants, bound));
  return { actual: textOf(file, actual), actualNode: actual, matcher, args, negated, ...(mode === undefined ? {} : { mode }) };
}

/** The enum members (`Enum.Member`) in the arguments of the matchers of a file, for their values by the types. */
function memberAccessesOf(file: SourceFile): Node[] {
  const found: Node[] = [];
  walk(file, (node) => {
    if (!is(node, SyntaxKind.CallExpression)) return true;
    const callee = unwrap(node['expression'] as Node);
    if (!is(callee, SyntaxKind.PropertyAccessExpression) || !/^to[A-Z]/.test(nameOf(callee['name']) ?? '')) return true;
    for (const arg of (node['arguments'] as Node[] | undefined) ?? []) {
      walk(arg, (inner) => {
        if (is(inner, SyntaxKind.PropertyAccessExpression) && is(unwrap(inner['expression'] as Node), SyntaxKind.Identifier) && /^[A-Z]/.test(nameOf(inner['name']) ?? '')) found.push(inner);
        return true;
      });
    }
    return true;
  });
  return found;
}

/** What a URL argument of a request is: its fixed path, the method its wrapper or init says, and the nodes its body may be in. */
export interface UrlShape {
  path?: string;
  method?: string;
}

/** The expressions a function returns: the body of an arrow, or the expressions of its `return` statements. */
function returnedBy(fn: Node): Node[] {
  const body = any(fn)['body'] as Node | undefined;
  if (body === undefined) return [];
  if (!is(body, SyntaxKind.Block)) return [body];
  const returned: Node[] = [];
  walk(body, (node) => {
    if (node !== fn && node !== body && (is(node, SyntaxKind.ArrowFunction) || is(node, SyntaxKind.FunctionExpression) || is(node, SyntaxKind.FunctionDeclaration))) return false;
    if (is(node, SyntaxKind.ReturnStatement) && node['expression'] !== undefined) returned.push(node['expression'] as Node);
    return true;
  });
  return returned;
}

/**
 * The URL of a request as written (undefined parts when it has no fixed path):
 * a string, a template (`${TEST_ISSUER}/token`), `a + '/x'`, a constant of
 * the file, `new URL('/x', base)`, `new Request(url, init)`, a helper that
 * builds the request from its first argument (`requestTo('/userinfo')`,
 * `formPost('/introspect', fields)`: `post` in its name makes it a POST), or
 * a function of the file whose result is one of these.
 */
export function urlOf(file: SourceFile, node: Node | undefined, scope: FileScope, seen = new Set<string>()): UrlShape {
  if (node === undefined) return {};
  const value = unwrap(node);
  const literal = stringOf(value);
  if (literal !== undefined) return { ...pathPart(pathOfText(literal)) };
  if (is(value, SyntaxKind.TemplateExpression)) {
    // The substitutions are left as a mark the path stops at.
    const text = [any(value)['head']['text'] as string, ...((value['templateSpans'] as Node[]) ?? []).map((span) => `\u0000${any(span)['literal']['text'] as string}`)].join('');
    return pathPart(pathOfText(text));
  }
  if (is(value, SyntaxKind.BinaryExpression) && any(value)['operatorToken'].kind === SyntaxKind.PlusToken) {
    const right = stringOf(unwrap(value['right'] as Node));
    if (right !== undefined && right.startsWith('/')) return pathPart(pathOfText(right));
    return urlOf(file, value['left'] as Node, scope, seen);
  }
  if (is(value, SyntaxKind.NewExpression)) {
    const name = nameOf(unwrap(value['expression'] as Node));
    const args = (value['arguments'] as Node[] | undefined) ?? [];
    if (name === 'URL') return urlOf(file, args[0], scope, seen);
    if (name === 'Request' || name === 'NextRequest') {
      const url = urlOf(file, args[0], scope, seen);
      const method = methodIn(args[1]) ?? url.method;
      return { ...url, ...(method === undefined ? {} : { method }) };
    }
    return {};
  }
  if (is(value, SyntaxKind.Identifier)) {
    const name = value['text'] as string;
    const initializer = scope.constants.get(name);
    if (initializer === undefined || seen.has(name)) return {};
    seen.add(name);
    return urlOf(file, initializer, scope, seen);
  }
  if (is(value, SyntaxKind.CallExpression)) {
    const callee = unwrap(value['expression'] as Node);
    const name = is(callee, SyntaxKind.Identifier) ? (callee['text'] as string) : is(callee, SyntaxKind.PropertyAccessExpression) ? nameOf(callee['name']) : undefined;
    const args = (value['arguments'] as Node[] | undefined) ?? [];
    const local = name === undefined || seen.has(`fn:${name}`) ? undefined : scope.functions.get(name);
    if (local !== undefined) {
      seen.add(`fn:${name}`);
      for (const returned of returnedBy(local)) {
        const url = urlOf(file, returned, scope, seen);
        if (url.path !== undefined) return url;
      }
    }
    const url = urlOf(file, args[0], scope, seen);
    if (url.path === undefined) return {};
    const method = /post/i.test(name ?? '') ? 'POST' : /preflight|options/i.test(name ?? '') ? 'OPTIONS' : (methodIn(args[1]) ?? url.method);
    return { ...url, ...(method === undefined ? {} : { method }) };
  }
  return {};
}

function pathPart(path: string | undefined): UrlShape {
  return path === undefined ? {} : { path };
}

/** The fixed path of a URL as written (see urlOf). */
export function pathOfUrl(file: SourceFile, node: Node | undefined, scope: FileScope): string | undefined {
  return urlOf(file, node, scope).path;
}

/** The fixed path of the text of a URL: after the origin, up to the query, the fragment or a substitution. */
export function pathOfText(text: string): string | undefined {
  let rest = text.replace(/^https?:\/\/[^/\u0000]*/, '');
  // A leading substitution is the origin (`${TEST_ISSUER}/token`).
  rest = rest.replace(/^\u0000+/, '');
  if (!rest.startsWith('/')) return undefined;
  const end = rest.search(/[?#\u0000]/);
  const path = end === -1 ? rest : rest.slice(0, end);
  return path === '' ? undefined : path.length > 1 ? path.replace(/\/$/, '') : path;
}

/** The keys of the object literals of the bodies and queries a request carries (`new URLSearchParams({...})`, `form: {...}`, `JSON.stringify({...})`). */
function paramsIn(file: SourceFile, nodes: readonly Node[], locals: ReadonlyMap<string, Node>): string[] {
  const keys: string[] = [];
  const add = (object: Node) => {
    for (const property of (any(object)['properties'] as Node[]) ?? []) {
      const key = nameOf(any(property)['name'] as Node | undefined);
      if (key !== undefined && !keys.includes(key)) keys.push(key);
    }
  };
  const seen = new Set<string>();
  const visit = (root: Node) =>
    walk(root, (node) => {
      if (is(node, SyntaxKind.NewExpression) && nameOf(unwrap(node['expression'] as Node)) === 'URLSearchParams') {
        const first = (node['arguments'] as Node[] | undefined)?.[0];
        const object = first === undefined ? undefined : unwrap(first);
        if (is(object, SyntaxKind.ObjectLiteralExpression)) add(object);
      } else if (is(node, SyntaxKind.CallExpression) && /^JSON\.stringify$/.test(textOf(file, node['expression'] as Node))) {
        const first = (node['arguments'] as Node[] | undefined)?.[0];
        const object = first === undefined ? undefined : unwrap(first);
        if (is(object, SyntaxKind.ObjectLiteralExpression)) add(object);
      } else if (is(node, SyntaxKind.PropertyAssignment) && ['form', 'data', 'params'].includes(nameOf(node['name'] as Node) ?? '')) {
        const object = unwrap(node['initializer'] as Node);
        if (is(object, SyntaxKind.ObjectLiteralExpression)) add(object);
      } else if (is(node, SyntaxKind.Identifier) || is(node, SyntaxKind.ShorthandPropertyAssignment)) {
        const name = is(node, SyntaxKind.Identifier) ? (node['text'] as string) : (nameOf(node['name'] as Node) ?? '');
        const local = locals.get(name);
        if (local !== undefined && !seen.has(name)) {
          seen.add(name);
          visit(local);
        }
      }
      return true;
    });
  for (const node of nodes) visit(node);
  return keys;
}

/** How a request authenticates its client, from its headers and body. */
function authOf(file: SourceFile, nodes: readonly Node[], params: readonly string[]): string | undefined {
  const text = nodes.map((node) => textOf(file, node)).join('\n');
  if (/basic(Auth|Authorization|Header)?\s*\(|['"`]Basic\s/i.test(text)) return 'client_secret_basic';
  if (params.includes('client_assertion')) return 'private_key_jwt';
  if (params.includes('client_secret')) return 'client_secret_post';
  if (/['"`]Bearer\s|bearer\s*\(/i.test(text)) return 'bearer';
  if (/DPoP/i.test(text)) return 'dpop';
  return undefined;
}

/** The method an init object (`{ method: 'POST' }`) names. */
function methodIn(init: Node | undefined): string | undefined {
  const object = init === undefined ? undefined : unwrap(init);
  if (!is(object, SyntaxKind.ObjectLiteralExpression)) return undefined;
  for (const property of (object['properties'] as Node[]) ?? []) {
    if (is(property, SyntaxKind.PropertyAssignment) && nameOf(property['name'] as Node) === 'method') return stringOf(unwrap(property['initializer'] as Node))?.toUpperCase();
  }
  return undefined;
}

const PLAYWRIGHT_METHODS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', head: 'HEAD', fetch: 'GET' };

/** The declarations of a file a test can reach by name: its functions and the values of its top-level constants. */
export interface FileScope {
  constants: Map<string, Node>;
  functions: Map<string, Node>;
}

/** The constants and functions declared at the top of a file and in the blocks of its tests (see FileScope). */
export function scopeOf(file: SourceFile): FileScope {
  const scope: FileScope = { constants: new Map(), functions: new Map() };
  walk(file, (node) => {
    if (is(node, SyntaxKind.FunctionDeclaration)) {
      const name = nameOf(node['name'] as Node | undefined);
      if (name !== undefined) scope.functions.set(name, node);
    } else if (is(node, SyntaxKind.VariableDeclaration)) {
      const name = nameOf(node['name'] as Node | undefined);
      const initializer = node['initializer'] as Node | undefined;
      if (name !== undefined && initializer !== undefined) {
        const value = unwrap(initializer);
        if (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression)) scope.functions.set(name, value);
        else if (!scope.constants.has(name)) scope.constants.set(name, initializer);
      }
    }
    return true;
  });
  return scope;
}

/** The requests a body sends, directly or through the functions of the file it calls (each read once). */
function requestsOf(file: SourceFile, body: Node, scope: FileScope, options: CodeReadOptions, imported: ReadonlyMap<string, string | undefined>): { requests: RequestShape[]; routes: string[] } {
  const requests: RequestShape[] = [];
  const routes: string[] = [];
  const visited = new Set<Node>();
  const push = (shape: Omit<RequestShape, 'line'>, at: Node) => {
    const line = startLine(file, at);
    if (!requests.some((known) => known.method === shape.method && known.path === shape.path && known.line === line)) requests.push({ ...shape, line });
  };
  const read = (root: Node, callers: readonly Node[]) => {
    if (visited.has(root)) return;
    visited.add(root);
    walk(root, (node) => {
      if (is(node, SyntaxKind.CallExpression)) {
        const callee = unwrap(node['expression'] as Node);
        const args = (node['arguments'] as Node[] | undefined) ?? [];
        const method = is(callee, SyntaxKind.PropertyAccessExpression) ? nameOf(callee['name']) : undefined;
        const name = is(callee, SyntaxKind.Identifier) ? (callee['text'] as string) : undefined;
        // The body and the headers may be in the request call, in the helper that builds its URL, or in the arguments of the helper of the test that sends it.
        const shape = (url: UrlShape, verb: string) => {
          if (url.path === undefined) return;
          const nodes = [...args, ...callers];
          // The fields a test hands to the helper that sends the request (`post({ grant_type: ... })`) are its params.
          const fields = callers[0] === undefined ? undefined : unwrap(callers[0]);
          const params = [...new Set([...paramsIn(file, nodes, scope.constants), ...(is(fields, SyntaxKind.ObjectLiteralExpression) ? ((fields['properties'] as Node[]) ?? []).map((property) => nameOf(any(property)['name'] as Node | undefined)).filter((key): key is string => key !== undefined) : [])])];
          const auth = authOf(file, nodes, params);
          const endpoint = options.endpointOfPath(url.path);
          push({ ...(endpoint === undefined ? {} : { endpoint }), method: verb, path: url.path, ...(params.length === 0 ? {} : { params }), ...(auth === undefined ? {} : { auth }) }, node);
        };
        if ((method === 'request' || method === 'fetch' || method === 'inject') && args.length > 0 && !/^(request|api|context)$/i.test(textOf(file, any(callee)['expression'] as Node))) {
          // `app.request(url, init)`, `app.fetch(new Request(...))`, `fastify.inject({ method, url })`.
          const url = method === 'inject' ? injectUrl(file, args[0], scope) : urlOf(file, args[0], scope);
          shape(url, methodIn(args[1]) ?? url.method ?? 'GET');
        } else if (method === 'goto' && args.length > 0) shape(urlOf(file, args[0], scope), 'GET');
        else if (method !== undefined && PLAYWRIGHT_METHODS[method] !== undefined && args.length > 0 && /request|api|context/i.test(textOf(file, any(callee)['expression'] as Node))) {
          const url = urlOf(file, args[0], scope);
          shape(url, method === 'fetch' ? (methodIn(args[1]) ?? url.method ?? 'GET') : (PLAYWRIGHT_METHODS[method] as string));
        } else if (name === 'fetch' && args.length > 0) {
          const url = urlOf(file, args[0], scope);
          shape(url, methodIn(args[1]) ?? url.method ?? 'GET');
        } else if (name !== undefined) {
          // A Route Handler of Next.js (`POST(request)`), or a function of this file that may send the request.
          const target = imported.get(name);
          const endpoint = target === undefined ? undefined : options.endpointOfFunction(target);
          if (endpoint !== undefined) {
            if (!routes.includes(endpoint)) routes.push(endpoint);
            const built = args.map((arg) => urlOf(file, arg, scope)).find((found) => found.path !== undefined);
            const nodes = [...args, ...callers];
            const params = paramsIn(file, nodes, scope.constants);
            const auth = authOf(file, nodes, params);
            push({ endpoint, method: /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(name) ? name : (built?.method ?? 'POST'), path: built?.path ?? '', ...(params.length === 0 ? {} : { params }), ...(auth === undefined ? {} : { auth }) }, node);
          }
          const local = scope.functions.get(name);
          if (local !== undefined) read(local, [...callers, ...args]);
        }
      }
      return true;
    });
  };
  read(body, []);
  return { requests, routes };
}

/** The URL of a `fastify.inject({ method, url })`. */
function injectUrl(file: SourceFile, node: Node | undefined, scope: FileScope): UrlShape {
  const object = node === undefined ? undefined : unwrap(node);
  if (!is(object, SyntaxKind.ObjectLiteralExpression)) return urlOf(file, node, scope);
  let url: UrlShape = {};
  for (const property of (object['properties'] as Node[]) ?? []) {
    if (is(property, SyntaxKind.PropertyAssignment) && nameOf(property['name'] as Node) === 'url') url = urlOf(file, property['initializer'] as Node, scope);
  }
  const method = methodIn(object);
  return { ...url, ...(method === undefined ? {} : { method }) };
}

/** The names a file imports, each with the node of its local name (an import specifier, a default import). */
export function importsOf(file: SourceFile): Map<string, Node> {
  const imports = new Map<string, Node>();
  walk(file, (node) => {
    if (is(node, SyntaxKind.ImportSpecifier) || is(node, SyntaxKind.ImportClause)) {
      const name = node['name'] as Node | undefined;
      const text = nameOf(name);
      if (name !== undefined && text !== undefined) imports.set(text, name);
    }
    return !is(node, SyntaxKind.FunctionDeclaration);
  });
  return imports;
}

/** The name of a function a describe block names: `parseTokenRequest`, `parseTokenRequest()`, `ClientStore.get` → its first part. */
function describedName(title: string): string {
  return /^[A-Za-z_$][\w$]*/.exec(title.trim())?.[0] ?? '';
}

/** The test cases of a file of test code (see the module comment). */
export function readCodeTests(file: SourceFile, options: CodeReadOptions): CodeTest[] {
  const scope = scopeOf(file);
  const importNodes = importsOf(file);
  const imported = new Map<string, string | undefined>();
  for (const [name, node] of importNodes) imported.set(name, options.importTarget(node));
  const accesses = memberAccessesOf(file);
  const constants = accesses.length === 0 || options.constantsOf === undefined ? new Map<Node, string>() : options.constantsOf(accesses);
  const tests: CodeTest[] = [];

  const visit = (statements: readonly Node[], path: string[], described: string[], skipped: boolean, pathIds: Array<string | undefined> = []) => {
    for (const statement of statements) {
      // Tests written in a loop or under a condition.
      if (is(statement, SyntaxKind.ForOfStatement) || is(statement, SyntaxKind.ForStatement) || is(statement, SyntaxKind.ForInStatement)) {
        const body = statement['statement'] as Node;
        visit(is(body, SyntaxKind.Block) ? (body['statements'] as Node[]) : [body], path, described, skipped, pathIds);
        continue;
      }
      if (is(statement, SyntaxKind.IfStatement)) {
        for (const branch of [statement['thenStatement'], statement['elseStatement']] as Array<Node | undefined>) {
          if (branch !== undefined) visit(is(branch, SyntaxKind.Block) ? (branch['statements'] as Node[]) : [branch], path, described, skipped, pathIds);
        }
        continue;
      }
      if (is(statement, SyntaxKind.Block)) {
        visit(statement['statements'] as Node[], path, described, skipped, pathIds);
        continue;
      }
      if (!is(statement, SyntaxKind.ExpressionStatement)) continue;
      // `await test.step(...)` and friends are not tests; `forEach` loops of tests are.
      let call = unwrap(statement['expression'] as Node);
      if (is(call, SyntaxKind.CallExpression)) {
        const callee = unwrap(call['expression'] as Node);
        if (is(callee, SyntaxKind.PropertyAccessExpression) && nameOf(callee['name']) === 'forEach') {
          const fn = callbackOf(call);
          visit(statementsOf(fn), path, described, skipped, pathIds);
          continue;
        }
      }
      if (!is(call, SyntaxKind.CallExpression)) continue;
      const kind = testCallOf(call);
      if (kind === undefined) continue;
      call = call as Node;
      const args = (any(call)['arguments'] as Node[] | undefined) ?? [];
      const title = titleOf(file, args[0]);
      const fn = callbackOf(call);
      if (kind.kind === 'describe') {
        const target = imported.get(describedName(title));
        visit(statementsOf(fn), [...path, title], target === undefined ? described : [...described, target], skipped || kind.skipped, [...pathIds, target]);
        continue;
      }
      const comments = readComments(leadingComments(file, statement), options.specReferencesOf);
      const expectations: Expectation[] = [];
      const assertions: Assertion[] = [];
      const urls: string[] = [];
      /** The actuals of the expectations, and the names they read (the values the test computed to check them). */
      const actuals: Node[] = [];
      const checked = new Set<string>();
      /** Read the expectations of a body, and of the helpers of the file it calls (two levels), their parameters bound to the values it hands them. */
      const visited = new Set<Node>();
      const collect = (root: Node, bound: ReadonlyMap<string, Value>, depth: number) => {
        if (visited.has(root)) return;
        visited.add(root);
        walk(root, (node) => {
          if (!is(node, SyntaxKind.CallExpression)) return true;
          const found = expectationOf(file, node, constants, bound);
          if (found === undefined) {
            const callee = unwrap(node['expression'] as Node);
            const helper = is(callee, SyntaxKind.Identifier) && depth < 2 ? scope.functions.get(callee['text'] as string) : undefined;
            if (helper !== undefined) {
              const parameters = ((any(helper)['parameters'] as Node[] | undefined) ?? []).map((parameter) => nameOf(any(parameter)['name'] as Node | undefined));
              const args = (node['arguments'] as Node[] | undefined) ?? [];
              const inner = new Map(bound);
              parameters.forEach((name, index) => {
                if (name !== undefined && args[index] !== undefined) inner.set(name, valueOf(file, args[index], constants, bound));
              });
              collect(helper, inner, depth + 1);
            }
            return true;
          }
          const { actualNode, ...expectation } = found;
          expectations.push(expectation);
          actuals.push(actualNode);
          walk(actualNode, (inner) => {
            if (is(inner, SyntaxKind.Identifier)) checked.add(inner['text'] as string);
            return true;
          });
          const said = sayExpectation(expectation);
          const expected = expectation.args[0] === undefined ? undefined : plainValue(expectation.args[0]);
          const ja = said.phrase === '' ? undefined : options.translate?.(said.phrase, said.holes);
          assertions.push({
            actual: expectation.actual.replace(/\s+/g, ' ').trim(),
            matcher: expectation.matcher,
            ...(expected === undefined ? {} : { expected }),
            ...(expectation.negated ? { negated: true } : {}),
            ...(expectation.mode === undefined ? {} : { mode: expectation.mode }),
            line: startLine(file, node),
            text: said.text,
            ...(said.phrase === '' ? {} : { phrase: said.phrase }),
            ...(ja === undefined ? {} : { ja }),
          });
          if (expectation.matcher === 'toHaveURL') {
            const first = expectation.args[0];
            const path = first?.kind === 'regexp' ? pathOfText(first.source.replace(/\\\//g, '/').replace(/^\^?(\.\*)?/, '').replace(/\$$/, '')) : first?.kind === 'string' ? pathOfText(first.value) : undefined;
            if (path !== undefined && !urls.includes(path)) urls.push(path);
          }
          return true;
        });
      };
      if (fn !== undefined) collect(fn, new Map(), 0);
      // The calls in what it checks: inside the actuals, and in the initializers of the names they read.
      const called: string[] = [];
      const acts: Node[] = [...actuals];
      if (fn !== undefined) {
        walk(fn, (node) => {
          if (is(node, SyntaxKind.VariableDeclaration) && node['initializer'] !== undefined) {
            const names: string[] = [];
            walk(node['name'] as Node, (inner) => {
              if (is(inner, SyntaxKind.Identifier)) names.push(inner['text'] as string);
              return true;
            });
            if (names.some((name) => checked.has(name))) acts.push(node['initializer'] as Node);
          }
          return true;
        });
      }
      for (const act of acts) {
        walk(act, (node) => {
          if (!is(node, SyntaxKind.CallExpression)) return true;
          const callee = unwrap(node['expression'] as Node);
          const name = is(callee, SyntaxKind.Identifier) ? (callee['text'] as string) : undefined;
          const target = name === undefined ? undefined : imported.get(name);
          if (target !== undefined && !called.includes(target)) called.push(target);
          return true;
        });
      }
      const { requests, routes } = fn === undefined ? { requests: [], routes: [] } : requestsOf(file, fn, scope, options, imported);
      const endpoints = [...routes];
      for (const url of urls) {
        const endpoint = options.endpointOfPath(url);
        if (endpoint !== undefined && !endpoints.includes(endpoint)) endpoints.push(endpoint);
      }
      tests.push({
        title,
        path,
        lines: [startLine(file, statement), endLine(file, statement)],
        comments,
        assertions,
        expectations,
        requests,
        described: [...new Set(described)],
        pathIds,
        called,
        endpoints,
        urls,
        skipped: skipped || kind.skipped,
        body: fn === undefined ? '' : textOf(file, fn),
      });
    }
  };
  visit((any(file)['statements'] as Node[]) ?? [], [], [], false);
  return tests;
}

/** The subjects of a test of the code from what it names, calls and requests (the endpoints of the given source). */
export function codeSubjects(test: CodeTest, sources: ReadonlyArray<'hono' | 'nextjs'>, isFunction: (id: string) => boolean): Subject[] {
  const subjects: Subject[] = [];
  const add = (subject: Subject) => {
    if (!subjects.some((known) => known.kind === subject.kind && known.id === subject.id && ('source' in known ? known.source : '') === ('source' in subject ? subject.source : ''))) subjects.push(subject);
  };
  for (const id of test.comments.subjects) {
    if (id.startsWith('endpoint:')) for (const source of sources) add({ kind: 'endpoint', id: id.slice('endpoint:'.length), source, how: 'declared' });
    else if (isFunction(id)) add({ kind: 'function', id, how: 'declared' });
  }
  for (const id of test.described) add({ kind: 'function', id, how: 'describe' });
  for (const id of test.called) add({ kind: 'function', id, how: 'call' });
  for (const endpoint of [...test.requests.map((request) => request.endpoint), ...test.endpoints]) {
    if (endpoint === undefined) continue;
    for (const source of sources) add({ kind: 'endpoint', id: endpoint, source, how: 'request' });
  }
  return subjects;
}
