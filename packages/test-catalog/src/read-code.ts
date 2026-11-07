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
 *   same file its body calls send: `app.request(url, init)`, `app.fetch()`,
 *   `fastify.inject()`, `fetch(url)` to a server it runs, `request.get()` /
 *   `.post()` of Playwright, `page.goto()`, a `Request` handed to a Route
 *   Handler, and the URL `toHaveURL()` expects. The path of the URL is its
 *   fixed part (`${TEST_ISSUER}/token` → `/token`), also when a helper builds
 *   it (`requestTo(authorizePath(params))`, the helper of a test support
 *   module read in its own file); a test of a table (`it.each(PATHS)`) sends
 *   the requests of each row, its parameters bound to the row's values
 *   (tableRows); a request sent to an app whose URL has no fixed part has
 *   the path ''. A Request only built for a context
 *   (`contextOf(requestTo('/token'))`) is no request, nor a `fetch()` the
 *   file mocks. A request that reaches no endpoint says why (`route`: a
 *   route the test registers itself, a route of the app, a path known at
 *   run time).
 * - Its subjects are the functions of the catalog its describe blocks name
 *   (through the imports of the file, by the types: `describe` names the
 *   function as the README asks), the functions of the catalog its body
 *   calls, the endpoints its requests reach (a route the test registers on
 *   the path itself is no endpoint: ownRoutes), and what its author declares.
 *   The code each describe block names, of the catalog or not (an app, a
 *   class), is kept too (CodeTest.pathCode): it answers the requests of the
 *   test that reach no endpoint.
 * - Its helpers are the functions its body calls (or hands to a call) that
 *   are no function of the catalog and no call of a test framework: the
 *   functions of its file, found by the scopes the name is used in (a
 *   `function`, or a `const` bound to an arrow function, at the top or in a
 *   describe block; a parameter such as a Playwright fixture is none), and
 *   the functions of the test support modules it imports, found by the types
 *   (CodeReadOptions.helperOf). The helpers a helper calls are its helpers
 *   too, a few calls deep, each once: the helpers the test calls itself are
 *   listed first (depth 1), each followed by those it calls in turn (depth
 *   2, ...), so a helper the test calls is never listed under another. A
 *   function written inside the test or inside a helper it lists is part of
 *   that code, not a helper of its own. The step definitions of the
 *   scenarios have their helpers the same way (fileHelpers).
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
import type { Assertion, NamedCodeRef, RequestRoute, RequestShape, Subject } from './model.js';
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
  /** For each block of its path, the code its name names, of the catalog or not (CodeReadOptions.describedCode): what answers its requests to routes that are no endpoint. */
  pathCode: Array<NamedCodeRef | undefined>;
  /** The functions of the catalog its body calls in what it checks: inside an `expect(...)`, or to compute a value an expectation checks (the calls that only arrange state are left out). */
  called: string[];
  /** The endpoints it reaches other than by the path of a request: the Route Handler (Next.js) it calls, the page it expects to be at. */
  endpoints: string[];
  /** The URLs its expectations expect a page to be at (`toHaveURL`), as paths. */
  urls: string[];
  skipped: boolean;
  /** The text of its body, for the diff (a body that changed without its expectations). */
  body: string;
  /** The helpers its body calls, directly or through another helper, in the order they are first called (see the module comment). */
  helpers: CodeHelper[];
}

/** A helper of a test as the reader finds it: a function of the test's own file, or of a test support module. */
export interface CodeHelper {
  /** The name the test (or the helper that calls it) calls it by. */
  name: string;
  /** Its file from the root of the repository; absent for a function of the test's own file. */
  file?: string;
  /** Its declaration (declarationLines). */
  lines: [number, number];
  /** 1 for a helper the test calls itself, 2 for one such a helper calls, ... (model.ts HelperRef.depth). */
  depth: number;
}

/** A function of a test support module a name refers to (CodeReadOptions.helperOf). */
export interface HelperDeclaration {
  /** Its file from the root of the repository. */
  file: string;
  /** Its declaration (declarationLines). */
  lines: [number, number];
  /** The function, whose calls are read for the helpers it calls in turn. */
  fn: Node;
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
  /**
   * The function of a test support module a name refers to, by the types: an
   * imported name of the test file, or a name a helper of another file calls.
   * Undefined for anything else (a function of the catalog, of a test
   * framework, of node_modules or of the runtime, a value that is no
   * function); without it the reader finds the helpers of the file only.
   */
  helperOf?(name: Node): HelperDeclaration | undefined;
  /**
   * The code a name of a describe block names (CodeTest.pathCode): the
   * declaration an imported name refers to by the types (`imported`, its
   * node), else one of that name at the top of the module the test file
   * tests (`app.test.ts` → `app.ts`); a function, a class or a variable of
   * the repository that is no test and no test support code. Without it no
   * block names code.
   */
  describedCode?(name: string, file: SourceFile, imported: Node | undefined): NamedCodeRef | undefined;
  /**
   * The value a name refers to when it is a constant of a test support
   * module (`PROVIDER_PATH_PREFLIGHTS`), by the types: the initializer of its
   * declaration, the table of an `it.each` the reader reads the rows of.
   */
  valueOf?(name: Node): Node | undefined;
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
  // `expect.objectContaining({...})` and `expect.arrayContaining([...])` expect what their literal says (a part of the value).
  if (is(value, SyntaxKind.CallExpression) && /^expect\.(objectContaining|arrayContaining)$/.test(textOf(file, value['expression'] as Node).replace(/\s+/g, ''))) {
    const inner = (value['arguments'] as Node[] | undefined)?.[0];
    if (inner !== undefined) return valueOf(file, inner, constants, bound);
  }
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
 * a string, a template (`${TEST_ISSUER}/token`), `a + '/x'` (or
 * `origin + authorizePath(params)`, the path on the right), a constant of
 * the file, `new URL('/x', base)`, `new Request(url, init)`, a helper that
 * builds the request from its first argument (`requestTo('/userinfo')`,
 * `formPost('/introspect', fields)`: `post` in its name makes it a POST), or
 * a function whose result is one of these: a function of the file, or a
 * helper of a test support module (FileScope.imported: `authorizePath(params)`
 * returns `'/authorize?' + ...`), read in its own file, a helper it calls in
 * turn too.
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
    const left = urlOf(file, value['left'] as Node, scope, seen);
    if (left.path !== undefined || right !== undefined) return left;
    // An origin and the path a helper builds (`origin + authorizePath(params)`).
    return urlOf(file, value['right'] as Node, scope, seen);
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
    const key = `${file.fileName}\u0000${name}`;
    if (initializer === undefined || seen.has(key)) return {};
    seen.add(key);
    return urlOf(file, initializer, scope, seen);
  }
  if (is(value, SyntaxKind.CallExpression)) {
    const callee = unwrap(value['expression'] as Node);
    const name = is(callee, SyntaxKind.Identifier) ? (callee['text'] as string) : is(callee, SyntaxKind.PropertyAccessExpression) ? nameOf(callee['name']) : undefined;
    const args = (value['arguments'] as Node[] | undefined) ?? [];
    const key = `${file.fileName}\u0000fn:${name ?? ''}`;
    const local = name === undefined || seen.has(key) ? undefined : scope.functions.get(name);
    // A function of the file, else a helper of a test support module the name refers to (its returns read in its own file).
    const imported = local !== undefined || name === undefined || seen.has(key) || !is(callee, SyntaxKind.Identifier) ? undefined : scope.imported?.(callee);
    const returning = local !== undefined ? { file, fn: local, scope } : imported;
    if (returning !== undefined) {
      seen.add(key);
      for (const returned of returnedBy(returning.fn)) {
        const url = urlOf(returning.file, returned, returning.scope, seen);
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
        // A name of the file whose value is a body (an object, `new URLSearchParams(...)`, `JSON.stringify(...)`); a value computed from another request is not this request's body.
        const name = is(node, SyntaxKind.Identifier) ? (node['text'] as string) : (nameOf(node['name'] as Node) ?? '');
        const local = locals.get(name);
        if (local !== undefined && !seen.has(name) && isBodyBuilder(file, local)) {
          seen.add(name);
          visit(local);
        }
      }
      return true;
    });
  for (const node of nodes) visit(node);
  return keys;
}

/** Whether an expression builds a body or a query: an object literal, `new URLSearchParams(...)` or `JSON.stringify(...)`. */
function isBodyBuilder(file: SourceFile, node: Node): boolean {
  const value = unwrap(node);
  if (is(value, SyntaxKind.ObjectLiteralExpression)) return true;
  if (is(value, SyntaxKind.NewExpression)) return nameOf(unwrap(value['expression'] as Node)) === 'URLSearchParams';
  if (is(value, SyntaxKind.CallExpression)) return /^JSON\.stringify$|\.toString$/.test(textOf(file, value['expression'] as Node)) && (!/\.toString$/.test(textOf(file, value['expression'] as Node)) || isBodyBuilder(file, any(value['expression'])['expression'] as Node));
  return false;
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
  /**
   * The function of a test support module a called name refers to, by the
   * types (CodeReadOptions.helperOf), with its file and the scope of that
   * file: urlOf reads what it returns. Absent, no other file is read.
   */
  imported?(name: Node): { file: SourceFile; fn: Node; scope: FileScope } | undefined;
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

/**
 * Whether a file stubs the global fetch (`vi.spyOn(globalThis, 'fetch')`,
 * `vi.stubGlobal('fetch', ...)`, `globalThis.fetch = ...`): its `fetch(url)`
 * calls answer from the stub, and send no request to an app.
 */
export function stubsGlobalFetch(file: SourceFile): boolean {
  let stubs = false;
  const isGlobal = (node: Node | undefined) => node !== undefined && /^(globalThis|global|window|self)$/.test(textOf(file, unwrap(node)));
  walk(file, (node) => {
    if (stubs) return false;
    if (is(node, SyntaxKind.CallExpression)) {
      const callee = textOf(file, unwrap(node['expression'] as Node)).replace(/\s+/g, '');
      const args = (node['arguments'] as Node[] | undefined) ?? [];
      const second = args[1] === undefined ? undefined : stringOf(unwrap(args[1]));
      const first = args[0] === undefined ? undefined : stringOf(unwrap(args[0]));
      if ((/(^|\.)spyOn$/.test(callee) && isGlobal(args[0]) && second === 'fetch') || (/(^|\.)stubGlobal$/.test(callee) && first === 'fetch')) stubs = true;
    } else if (is(node, SyntaxKind.BinaryExpression) && any(node)['operatorToken'].kind === SyntaxKind.EqualsToken) {
      const left = unwrap(node['left'] as Node);
      if (is(left, SyntaxKind.PropertyAccessExpression) && nameOf(left['name']) === 'fetch' && isGlobal(left['expression'] as Node)) stubs = true;
    }
    return !stubs;
  });
  return stubs;
}

/** Whether a scope around a node declares a name (a parameter, a variable, a function of its own): the name is not the global one. */
function declaredAround(name: string, at: Node): boolean {
  for (let scope = at.parent; scope !== undefined; scope = scope.parent) if (scopeNames(scope).has(name)) return true;
  return false;
}

/**
 * The requests a body sends, directly or through the functions of the file
 * it calls (each read once). A request handed to an app, a handler or a
 * server (`app.request()`, `app.fetch()`, `fastify.inject()`, `fetch(url)`)
 * is sent whatever its URL: one whose URL has no fixed path (a parameter of
 * the test, the URL of a server it starts) has the path '' and the route
 * `unknown`. A `fetch(url)` of the file's own (a parameter, a mock it
 * declares) or of a file that stubs the global fetch sends nothing; neither
 * does a Request built and not handed to an app
 * (`contextOf(requestTo('/token'))`). Its endpoint is the endpoint its path
 * is, unless the test registers a route of its own on the path (ownRoutes:
 * the route `own`); a path no endpoint has is a route of the app (`app`).
 */
function requestsOf(file: SourceFile, body: Node, scope: FileScope, options: CodeReadOptions, imported: ReadonlyMap<string, string | undefined>): { requests: RequestShape[]; routes: string[] } {
  const requests: RequestShape[] = [];
  const routes: string[] = [];
  const visited = new Set<Node>();
  const own = ownRoutesOf(file);
  let stubbed: boolean | undefined;
  const stubsFetch = () => (stubbed ??= stubsGlobalFetch(file));
  const push = (shape: Omit<RequestShape, 'line'>, at: Node) => {
    const line = startLine(file, at);
    const known = requests.find((request) => request.method === shape.method && request.path === shape.path && request.line === line);
    if (known === undefined) {
      requests.push({ ...shape, line });
      return;
    }
    // The same request read again through another call: what that call adds (its fields) joins it.
    const params = [...new Set([...(known.params ?? []), ...(shape.params ?? [])])];
    if (params.length > 0) known.params = params;
    if (known.auth === undefined && shape.auth !== undefined) known.auth = shape.auth;
  };
  const read = (root: Node, callers: readonly Node[], depth = 0) => {
    const helper = root !== body;
    // A helper is read again for each call with fields of its own (its params), three helpers deep at most (helpers may call one another).
    if ((visited.has(root) && callers.length === 0) || depth > 3) return;
    visited.add(root);
    walk(root, (node) => {
      // A helper's own body runs when it is called; the functions it only defines (`const post = ...` in a factory) run when they are called.
      if (helper && node !== root && (is(node, SyntaxKind.ArrowFunction) || is(node, SyntaxKind.FunctionExpression) || is(node, SyntaxKind.FunctionDeclaration))) return false;
      if (is(node, SyntaxKind.CallExpression)) {
        const callee = unwrap(node['expression'] as Node);
        const args = (node['arguments'] as Node[] | undefined) ?? [];
        const method = is(callee, SyntaxKind.PropertyAccessExpression) ? nameOf(callee['name']) : undefined;
        const name = is(callee, SyntaxKind.Identifier) ? (callee['text'] as string) : undefined;
        // The body and the headers may be in the request call, in the helper that builds its URL, or in the arguments of the helper of the test that sends it.
        // A request sent to an app is kept without a fixed path (''); a page or a request of Playwright only with one.
        const shape = (url: UrlShape, verb: string, sent = false) => {
          if (url.path === undefined && !sent) return;
          const path = url.path ?? '';
          const nodes = [...args, ...callers];
          // The fields a test hands to the helper that sends the request (`post({ grant_type: ... })`) are its params.
          const fields = callers[0] === undefined ? undefined : unwrap(callers[0]);
          const params = [...new Set([...paramsIn(file, nodes, scope.constants), ...(is(fields, SyntaxKind.ObjectLiteralExpression) ? ((fields['properties'] as Node[]) ?? []).map((property) => nameOf(any(property)['name'] as Node | undefined)).filter((key): key is string => key !== undefined) : [])])];
          const auth = authOf(file, nodes, params);
          const endpoint = path === '' || own.has(path) ? undefined : options.endpointOfPath(path);
          const route: RequestRoute | undefined = endpoint !== undefined ? undefined : path === '' ? 'unknown' : own.has(path) ? 'own' : 'app';
          push({ ...(endpoint === undefined ? {} : { endpoint }), ...(route === undefined ? {} : { route }), method: verb, path, ...(params.length === 0 ? {} : { params }), ...(auth === undefined ? {} : { auth }) }, node);
        };
        const receiver = is(callee, SyntaxKind.PropertyAccessExpression) ? textOf(file, any(callee)['expression'] as Node) : undefined;
        // `globalThis.fetch(url)` is the global fetch, as `fetch(url)` is.
        const globalFetch = method === 'fetch' && receiver !== undefined && /^(globalThis|global|window|self)$/.test(receiver);
        if ((method === 'request' || method === 'fetch' || method === 'inject') && !globalFetch && args.length > 0 && !/^(request|api|context)$/i.test(receiver ?? '')) {
          // `app.request(url, init)`, `app.fetch(new Request(...))`, `fastify.inject({ method, url })`.
          const url = method === 'inject' ? injectUrl(file, args[0], scope) : urlOf(file, args[0], scope);
          shape(url, methodIn(args[1]) ?? url.method ?? 'GET', true);
        } else if (method === 'goto' && args.length > 0) shape(urlOf(file, args[0], scope), 'GET');
        else if (method !== undefined && !globalFetch && PLAYWRIGHT_METHODS[method] !== undefined && args.length > 0 && /request|api|context/i.test(receiver ?? '')) {
          const url = urlOf(file, args[0], scope);
          shape(url, method === 'fetch' ? (methodIn(args[1]) ?? url.method ?? 'GET') : (PLAYWRIGHT_METHODS[method] as string));
        } else if (((name === 'fetch' && !declaredAround('fetch', callee)) || globalFetch) && args.length > 0) {
          // `fetch(url)` to a server the test runs: not a fetch of its own (a mock it declares, a parameter), nor one the file stubs.
          if (!stubsFetch()) {
            const url = urlOf(file, args[0], scope);
            shape(url, methodIn(args[1]) ?? url.method ?? 'GET', true);
          }
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
          if (local !== undefined) read(local, [...callers, ...args], depth + 1);
        }
      }
      return true;
    });
  };
  read(body, []);
  return { requests, routes };
}

/**
 * The paths a test file registers a handler of its own on (`router.post('/token', (c) => ...)`,
 * `router.get('status', ...)` for `/status`): a request to one of them reaches the test's route,
 * not the endpoint of the provider.
 */
export function ownRoutes(file: SourceFile): Set<string> {
  const routes = new Set<string>();
  walk(file, (node) => {
    if (!is(node, SyntaxKind.CallExpression)) return true;
    const callee = unwrap(node['expression'] as Node);
    const method = is(callee, SyntaxKind.PropertyAccessExpression) ? (nameOf(callee['name']) ?? '') : '';
    if (!/^(get|post|put|patch|delete|all|on|use|mount|route)$/.test(method)) return true;
    const args = (node['arguments'] as Node[] | undefined) ?? [];
    const path = stringOf(args[0] === undefined ? undefined : unwrap(args[0]));
    const handler = args[args.length - 1] === undefined ? undefined : unwrap(args[args.length - 1] as Node);
    // A handler of the test's own, or a router of its own mounted on the path.
    const owned = handler !== undefined && (is(handler, SyntaxKind.ArrowFunction) || is(handler, SyntaxKind.FunctionExpression) || method === 'mount' || method === 'route');
    if (path === undefined || args.length < 2 || !owned) return true;
    // A route registered without its leading slash (`'status'`) is matched with it.
    if (path.startsWith('/')) routes.add(path);
    else if (/^[\w.~-]/.test(path)) routes.add(`/${path}`);
    return true;
  });
  return routes;
}

/** The own routes of each file read (ownRoutes), as a test of a table reads its body once a row. */
const ownRoutesByFile = new WeakMap<SourceFile, Set<string>>();

function ownRoutesOf(file: SourceFile): Set<string> {
  let routes = ownRoutesByFile.get(file);
  if (routes === undefined) {
    routes = ownRoutes(file);
    ownRoutesByFile.set(file, routes);
  }
  return routes;
}

/**
 * The values the parameters of a test of a table (`it.each(table)(title,
 * fn)`, `it.for(table)(...)`) take in each row, one map a row by the names
 * its function binds: `({ path }) => ...` for a row that is an object,
 * `(path) => ...` for one that is a string, `(method, path) => ...` (or
 * `([method, path]) => ...` with `for`) for one that is an array. The table
 * is an array literal of the test, a constant of its file, or a constant of
 * a test support module (CodeReadOptions.valueOf); only the values written
 * as strings are bound. Undefined for a test of no table, or of a table the
 * reader cannot read.
 */
export function tableRows(call: Node, fn: Node, scope: FileScope, options: Pick<CodeReadOptions, 'valueOf'>): Array<Map<string, Node>> | undefined {
  const callee = unwrap(any(call)['expression'] as Node);
  if (!is(callee, SyntaxKind.CallExpression)) return undefined;
  const each = unwrap(callee['expression'] as Node);
  const how = is(each, SyntaxKind.PropertyAccessExpression) ? nameOf(each['name']) : undefined;
  if (how !== 'each' && how !== 'for') return undefined;
  const arrayOf = (node: Node | undefined, depth = 0): Node | undefined => {
    if (node === undefined || depth > 3) return undefined;
    const value = unwrap(node);
    if (is(value, SyntaxKind.ArrayLiteralExpression)) return value;
    if (!is(value, SyntaxKind.Identifier)) return undefined;
    return arrayOf(scope.constants.get(value['text'] as string) ?? options.valueOf?.(value), depth + 1);
  };
  const table = arrayOf(((callee['arguments'] as Node[] | undefined) ?? [])[0]);
  if (table === undefined) return undefined;
  const parameters = ((any(fn)['parameters'] as Node[] | undefined) ?? []).map((parameter) => any(parameter)['name'] as Node | undefined);
  const bind = (bound: Map<string, Node>, name: Node | undefined, node: Node | undefined) => {
    if (name === undefined || node === undefined) return;
    const value = unwrap(node);
    if (is(name, SyntaxKind.Identifier)) {
      if (stringOf(value) !== undefined) bound.set(name['text'] as string, value);
    } else if (is(name, SyntaxKind.ObjectBindingPattern) && is(value, SyntaxKind.ObjectLiteralExpression)) {
      for (const element of (name['elements'] as Node[] | undefined) ?? []) {
        const key = nameOf((any(element)['propertyName'] ?? any(element)['name']) as Node | undefined);
        const property = ((value['properties'] as Node[] | undefined) ?? []).find((candidate) => is(candidate, SyntaxKind.PropertyAssignment) && nameOf(candidate['name'] as Node) === key);
        bind(bound, any(element)['name'] as Node | undefined, property === undefined ? undefined : (any(property)['initializer'] as Node));
      }
    } else if (is(name, SyntaxKind.ArrayBindingPattern) && is(value, SyntaxKind.ArrayLiteralExpression)) {
      const items = (value['elements'] as Node[] | undefined) ?? [];
      ((name['elements'] as Node[] | undefined) ?? []).forEach((element, index) => {
        if (is(element, SyntaxKind.BindingElement)) bind(bound, element['name'] as Node, items[index]);
      });
    }
  };
  const rows: Array<Map<string, Node>> = [];
  for (const element of (any(table)['elements'] as Node[] | undefined) ?? []) {
    const row = unwrap(element);
    const bound = new Map<string, Node>();
    // `each` spreads a row that is an array over the parameters; `for` hands every row as the first one.
    if (how === 'each' && is(row, SyntaxKind.ArrayLiteralExpression)) parameters.forEach((name, index) => bind(bound, name, ((row['elements'] as Node[] | undefined) ?? [])[index]));
    else bind(bound, parameters[0], row);
    rows.push(bound);
  }
  return rows.some((row) => row.size > 0) ? rows : undefined;
}

/** The requests of a test of a table: its body read once a row, its parameters bound to the row's values, each request once in the order of the rows. */
function requestsOfRows(file: SourceFile, body: Node, scope: FileScope, options: CodeReadOptions, imported: ReadonlyMap<string, string | undefined>, rows: ReadonlyArray<ReadonlyMap<string, Node>>): { requests: RequestShape[]; routes: string[] } {
  const requests: RequestShape[] = [];
  const routes: string[] = [];
  for (const row of rows) {
    const read = requestsOf(file, body, { ...scope, constants: new Map([...scope.constants, ...row]) }, options, imported);
    for (const request of read.requests) if (!requests.some((known) => known.method === request.method && known.path === request.path && known.line === request.line)) requests.push(request);
    for (const route of read.routes) if (!routes.includes(route)) routes.push(route);
  }
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

/**
 * The lines of a declaration (a function, the variable statement of an arrow
 * function, a statement): from its JSDoc, or from the comment lines right
 * above it (no blank line between), to its end. `last` is where it ends when
 * that is another node: the implementation of an overloaded function.
 */
export function declarationLines(file: SourceFile, first: Node, last: Node = first): [number, number] {
  let start = first.getStart(file, true);
  let next = first.getStart(file);
  const ranges = getLeadingCommentRanges(file.text, first.pos) ?? [];
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index] as { pos: number; end: number };
    if ((file.text.slice(range.end, next).match(/\n/g) ?? []).length > 1) break;
    start = Math.min(start, range.pos);
    next = range.pos;
  }
  return [file.getLineAndCharacterOfPosition(start).line + 1, endLine(file, last)];
}

/** The calls of the test frameworks (Vitest, Playwright, playwright-bdd): never a helper, `test` and `expect` of tests/e2e/fixtures.ts included. */
const FRAMEWORK = new Set(['describe', 'suite', 'it', 'test', 'bench', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'vi', 'vitest', 'createBdd', 'Given', 'When', 'Then', 'Step', 'Before', 'After', 'BeforeAll', 'AfterAll']);

/** How deep the helpers of a helper are read: a helper of the test, its helpers, and so on. */
const HELPER_DEPTH = 4;

/** What a name refers to in a scope of a file: a function of the file, another name (`const send = post`), or something that is no helper (a parameter, a value, a class). */
type Declared = { kind: 'function'; fn: Node; first: Node; last: Node } | { kind: 'alias'; target: Node } | { kind: 'other' };

const OTHER: Declared = { kind: 'other' };

/** The kinds of node whose parameters are names of their body. */
const WITH_PARAMETERS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/** The names a binding binds: an identifier, or the names of a destructuring pattern. */
function boundNames(name: Node | undefined): string[] {
  if (name === undefined) return [];
  if (is(name, SyntaxKind.Identifier)) return [name['text'] as string];
  if (is(name, SyntaxKind.ObjectBindingPattern) || is(name, SyntaxKind.ArrayBindingPattern)) return ((name['elements'] as Node[] | undefined) ?? []).flatMap((element) => (is(element, SyntaxKind.BindingElement) ? boundNames(element['name'] as Node) : []));
  return [];
}

/** The names a scope declares (a block, a file, a function's parameters, the variable of a `catch` or a `for`), each with what it refers to. */
function scopeNames(scope: Node): Map<string, Declared> {
  const names = new Map<string, Declared>();
  const other = (name: Node | undefined) => {
    for (const bound of boundNames(name)) if (!names.has(bound)) names.set(bound, OTHER);
  };
  if (WITH_PARAMETERS.has(scope.kind)) {
    for (const parameter of (any(scope)['parameters'] as Node[] | undefined) ?? []) other(any(parameter)['name'] as Node | undefined);
    // A function expression's own name refers to itself: a call of it is a recursion, not a helper.
    if (is(scope, SyntaxKind.FunctionExpression)) other(scope['name'] as Node | undefined);
  }
  if (is(scope, SyntaxKind.CatchClause)) {
    const variable = scope['variableDeclaration'] as Node | undefined;
    other(variable === undefined ? undefined : (any(variable)['name'] as Node | undefined));
  }
  if (is(scope, SyntaxKind.ForStatement) || is(scope, SyntaxKind.ForOfStatement) || is(scope, SyntaxKind.ForInStatement)) {
    const initializer = scope['initializer'] as Node | undefined;
    if (is(initializer, SyntaxKind.VariableDeclarationList)) for (const declaration of (initializer['declarations'] as Node[]) ?? []) other(any(declaration)['name'] as Node | undefined);
  }
  const statements = any(scope)['statements'] as Node[] | undefined;
  if (!Array.isArray(statements)) return names;
  /** The first declaration of each overloaded function: its lines start there. */
  const signatures = new Map<string, Node>();
  for (const statement of statements) {
    if (is(statement, SyntaxKind.FunctionDeclaration)) {
      const name = nameOf(statement['name'] as Node | undefined);
      if (name === undefined) continue;
      const first = signatures.get(name) ?? statement;
      signatures.set(name, first);
      // A signature (an overload, a `declare function`) has no code; the implementation that follows it does.
      if (statement['body'] !== undefined) names.set(name, { kind: 'function', fn: statement, first, last: statement });
      else if (!names.has(name)) names.set(name, OTHER);
    } else if (is(statement, SyntaxKind.VariableStatement)) {
      for (const declaration of (any(statement['declarationList'])['declarations'] as Node[]) ?? []) {
        const name = declaration === undefined ? undefined : (any(declaration)['name'] as Node | undefined);
        const initializer = any(declaration)['initializer'] as Node | undefined;
        const value = initializer === undefined ? undefined : unwrap(initializer);
        if (is(name, SyntaxKind.Identifier) && (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression))) names.set(name['text'] as string, { kind: 'function', fn: value as Node, first: statement, last: statement });
        else if (is(name, SyntaxKind.Identifier) && is(value, SyntaxKind.Identifier)) names.set(name['text'] as string, { kind: 'alias', target: value as Node });
        else other(name);
      }
    } else if (is(statement, SyntaxKind.ClassDeclaration) || is(statement, SyntaxKind.EnumDeclaration) || is(statement, SyntaxKind.ModuleDeclaration)) {
      other(statement['name'] as Node | undefined);
    }
  }
  return names;
}

/** Whether a node is inside another (in its subtree, the node itself aside). */
function within(node: Node, container: Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) if (current === container) return true;
  return false;
}

/** The names a body calls (`f(...)`) or hands to a call (`items.map(f)`), in the order of the text; the calls of the test frameworks left out. */
function calleesIn(root: Node): Node[] {
  const found: Node[] = [];
  walk(root, (node) => {
    if (!is(node, SyntaxKind.Identifier) || FRAMEWORK.has(node['text'] as string)) return true;
    const parent = node.parent;
    if (is(parent, SyntaxKind.CallExpression) && (parent['expression'] === node || ((parent['arguments'] as Node[] | undefined) ?? []).includes(node))) found.push(node);
    return true;
  });
  return found;
}

/** A helper as found, with the function to read its calls from and whether that function is of the test's own file. */
interface FoundHelper {
  helper: Omit<CodeHelper, 'depth'>;
  fn: Node;
  local: boolean;
}

/**
 * The helpers of the tests of a file (see the module comment): the names a
 * body calls looked up in the scopes they are used in, an import looked up
 * by the types (`helperOf`) unless it is a function of the catalog
 * (`imported`), the calls of a helper of another file looked up by the types.
 */
function helperReader(file: SourceFile, imports: ReadonlyMap<string, Node>, imported: ReadonlyMap<string, string | undefined>, helperOf: CodeReadOptions['helperOf']): (body: Node) => CodeHelper[] {
  const scopes = new Map<Node, Map<string, Declared>>();
  const importHelpers = new Map<Node, HelperDeclaration | null>();
  const callees = new Map<Node, Node[]>();
  const namesOf = (scope: Node) => {
    let names = scopes.get(scope);
    if (names === undefined) {
      names = scopeNames(scope);
      scopes.set(scope, names);
    }
    return names;
  };
  /** What a name used at a node refers to: the innermost scope that declares it, else an import. */
  const lookup = (name: string, at: Node, hops = 0): Declared | { kind: 'import'; node: Node } | undefined => {
    for (let scope = at.parent; scope !== undefined; scope = scope.parent) {
      const declared = namesOf(scope).get(name);
      if (declared === undefined) continue;
      if (declared.kind !== 'alias') return declared;
      // `const send = post`: what `post` refers to where `send` is bound, a few names deep.
      return hops < 3 ? lookup(any(declared.target)['text'] as string, declared.target, hops + 1) : undefined;
    }
    const node = imports.get(name);
    return node === undefined ? undefined : { kind: 'import', node };
  };
  const importHelper = (node: Node): HelperDeclaration | undefined => {
    let known = importHelpers.get(node);
    if (known === undefined) {
      known = helperOf?.(node) ?? null;
      importHelpers.set(node, known);
    }
    return known ?? undefined;
  };
  /** The helper a callee of a body is: by the scopes of the test file, or by the types for the body of a helper of another file. */
  const helperAt = (callee: Node, local: boolean): FoundHelper | undefined => {
    const name = any(callee)['text'] as string;
    if (!local) {
      const declaration = helperOf?.(callee);
      return declaration === undefined ? undefined : { helper: { name, file: declaration.file, lines: declaration.lines }, fn: declaration.fn, local: false };
    }
    const declared = lookup(name, callee);
    if (declared === undefined || declared.kind === 'other' || declared.kind === 'alias') return undefined;
    if (declared.kind === 'function') return { helper: { name, lines: declarationLines(file, declared.first, declared.last) }, fn: declared.fn, local: true };
    // An import: a function of the catalog is a subject or what the test arranges, not a helper.
    if (imported.get(nameOf(declared.node) ?? '') !== undefined) return undefined;
    const declaration = importHelper(declared.node);
    return declaration === undefined ? undefined : { helper: { name, file: declaration.file, lines: declaration.lines }, fn: declaration.fn, local: false };
  };
  const calleesOf = (fn: Node) => {
    let list = callees.get(fn);
    if (list === undefined) {
      list = calleesIn(fn);
      callees.set(fn, list);
    }
    return list;
  };
  return (body) => {
    const found: CodeHelper[] = [];
    const listed = new Set<Node>();
    /** The helpers a function calls that no list has yet, in the order of their first call, each taken at once: its siblings are never under it. */
    const callsOf = (root: Node, local: boolean): FoundHelper[] => {
      const helpers: FoundHelper[] = [];
      for (const callee of root === body ? calleesIn(body) : calleesOf(root)) {
        const helper = helperAt(callee, local);
        // A function written in the test, or in the code being read, is part of that code.
        if (helper === undefined || listed.has(helper.fn) || helper.fn === body || within(helper.fn, body) || within(helper.fn, root)) continue;
        listed.add(helper.fn);
        helpers.push(helper);
      }
      return helpers;
    };
    /** A helper, then the helpers it calls under it, depth first. */
    const add = (helper: FoundHelper, depth: number) => {
      found.push({ ...helper.helper, depth });
      if (depth >= HELPER_DEPTH) return;
      for (const next of callsOf(helper.fn, helper.local)) add(next, depth + 1);
    };
    for (const helper of callsOf(body, true)) add(helper, 1);
    return found;
  };
}

/**
 * The helpers of the functions of a file that is no test file (a file of
 * step definitions): read as those of a test (helperReader), with no
 * function of the catalog among its imports (the project of such a file
 * resolves none: a function the types find in no test support module is no
 * helper anyway).
 */
export function fileHelpers(file: SourceFile, helperOf: CodeReadOptions['helperOf']): (fn: Node) => CodeHelper[] {
  return helperReader(file, importsOf(file), new Map(), helperOf);
}

/** The scopes of the files of test support modules a test file reads the helpers of, by file (they are read for every test file that imports them). */
const supportScopes = new WeakMap<SourceFile, FileScope>();

/**
 * A scope of a test file whose calls of a helper of a test support module
 * read that helper in its own file (FileScope.imported), and the helpers it
 * calls in turn; without `helperOf` the file alone.
 */
function withImports(scope: FileScope, helperOf: CodeReadOptions['helperOf']): FileScope {
  if (helperOf === undefined) return scope;
  const imported = (name: Node): { file: SourceFile; fn: Node; scope: FileScope } | undefined => {
    const declaration = helperOf(name);
    if (declaration === undefined) return undefined;
    const file = declaration.fn.getSourceFile();
    let own = supportScopes.get(file);
    if (own === undefined) {
      own = scopeOf(file);
      supportScopes.set(file, own);
    }
    return { file, fn: declaration.fn, scope: { ...own, imported } };
  };
  return { ...scope, imported };
}

/** The test cases of a file of test code (see the module comment). */
export function readCodeTests(file: SourceFile, options: CodeReadOptions): CodeTest[] {
  const scope = withImports(scopeOf(file), options.helperOf);
  const importNodes = importsOf(file);
  const imported = new Map<string, string | undefined>();
  for (const [name, node] of importNodes) imported.set(name, options.importTarget(node));
  const accesses = memberAccessesOf(file);
  const constants = accesses.length === 0 || options.constantsOf === undefined ? new Map<Node, string>() : options.constantsOf(accesses);
  const helpersOf = helperReader(file, importNodes, imported, options.helperOf);
  const tests: CodeTest[] = [];

  const visit = (statements: readonly Node[], path: string[], described: string[], skipped: boolean, pathIds: Array<string | undefined> = [], pathCode: Array<NamedCodeRef | undefined> = []) => {
    for (const statement of statements) {
      // Tests written in a loop or under a condition.
      if (is(statement, SyntaxKind.ForOfStatement) || is(statement, SyntaxKind.ForStatement) || is(statement, SyntaxKind.ForInStatement)) {
        const body = statement['statement'] as Node;
        visit(is(body, SyntaxKind.Block) ? (body['statements'] as Node[]) : [body], path, described, skipped, pathIds, pathCode);
        continue;
      }
      if (is(statement, SyntaxKind.IfStatement)) {
        for (const branch of [statement['thenStatement'], statement['elseStatement']] as Array<Node | undefined>) {
          if (branch !== undefined) visit(is(branch, SyntaxKind.Block) ? (branch['statements'] as Node[]) : [branch], path, described, skipped, pathIds, pathCode);
        }
        continue;
      }
      if (is(statement, SyntaxKind.Block)) {
        visit(statement['statements'] as Node[], path, described, skipped, pathIds, pathCode);
        continue;
      }
      if (!is(statement, SyntaxKind.ExpressionStatement)) continue;
      // `await test.step(...)` and friends are not tests; `forEach` loops of tests are.
      let call = unwrap(statement['expression'] as Node);
      if (is(call, SyntaxKind.CallExpression)) {
        const callee = unwrap(call['expression'] as Node);
        if (is(callee, SyntaxKind.PropertyAccessExpression) && nameOf(callee['name']) === 'forEach') {
          const fn = callbackOf(call);
          visit(statementsOf(fn), path, described, skipped, pathIds, pathCode);
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
        const name = describedName(title);
        const target = imported.get(name);
        const code = name === '' ? undefined : options.describedCode?.(name, file, importNodes.get(name));
        visit(statementsOf(fn), [...path, title], target === undefined ? described : [...described, target], skipped || kind.skipped, [...pathIds, target], [...pathCode, code]);
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
      // A helper is read again at each call (its parameters bound to that call's values); the depth stops a helper that calls itself.
      const collect = (root: Node, bound: ReadonlyMap<string, Value>, depth: number) => {
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
            // The names the actual reads; the name of a property (`.payload`) is no variable of the test.
            const parent = inner.parent;
            const isPropertyName = parent !== undefined && (is(parent, SyntaxKind.PropertyAccessExpression) || is(parent, SyntaxKind.PropertyAssignment)) && any(parent)['name'] === inner;
            if (is(inner, SyntaxKind.Identifier) && !isPropertyName) checked.add(inner['text'] as string);
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
      // A test of a table sends the requests of each row (`it.each(PATHS)('should answer $path', ({ path }) => ...)`).
      const rows = fn === undefined ? undefined : tableRows(call, fn, scope, options);
      const { requests, routes } = fn === undefined ? { requests: [], routes: [] } : rows === undefined ? requestsOf(file, fn, scope, options, imported) : requestsOfRows(file, fn, scope, options, imported, rows);
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
        pathCode,
        called,
        endpoints,
        urls,
        skipped: skipped || kind.skipped,
        body: fn === undefined ? '' : textOf(file, fn),
        helpers: fn === undefined ? [] : helpersOf(fn),
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
