import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodesOf } from '../tree.js';
import { callOrder, compile, outline, type Fixture } from './helpers.js';

/**
 * The trees of small functions, compiled with the TypeScript compiler. The
 * cases follow the ones the lexical flow reader of the CLI was tested with
 * (the calls in order, the conditions, the returns and throws), in the shape
 * of the tree.
 */
const SOURCE = `
export class TokenError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export const TokenErrorCode = { InvalidRequest: 'invalid_request', InvalidClient: 'invalid_client' } as const;
export enum Kind { A = 'a_kind' }

export function parse(a: unknown) { return a; }
export function build(x: unknown) { return x; }
export function helper(b: unknown) { return b; }
export function outer(x: unknown) { return x; }
export function inner(x: unknown) { return x; }
export function store(x: unknown) { return x; }
export function isCurrent(x: unknown): boolean { return Boolean(x); }
export function check(): boolean { return true; }
export function cached() { return 1; }
export function fresh() { return 2; }
export function fail() { return 3; }
export function fallback() { return 4; }
export function accept() { return 5; }
export function reject() { return 6; }
export function first() {}
export function second() {}
export function recover(error?: unknown) { return error; }
export function a() { return 1; }
export function b() { return 2; }
export function c() { return 3; }
export function done() { return 4; }
export function use(y: number) { return y; }
export function isValid(x: unknown): boolean { return Boolean(x); }

export function sequence(a: unknown, b: unknown) {
  const x = parse(a);
  helper(b);
  return build(x);
}

export function nested() {
  return outer(inner(1));
}

export function noReturn() {

  store(1);
}

export function guard(session: unknown) {
  // Reject sessions older than the requested max_age.
  if (!isCurrent(session)) return undefined;
  return session;
}

export function shortCircuit(ok: boolean) { if (ok && check()) return cached(); return fresh(); }

export function unreachable(x: { bad?: boolean } | undefined) { if (x) { if (x.bad) return fail(); return cached(); } else { return fresh(); } }

export function nullish(value: unknown) { const result = value ?? fallback(); return result; }
export function or(value: unknown) { const result = value || fallback(); return result; }
export function and(value: unknown) { const result = value && fallback(); return result; }
export function ternary(ok: boolean) { return ok ? accept() : reject(); }

export function tried() { try { first(); second(); throw new TokenError(TokenErrorCode.InvalidRequest, 'bad'); } catch (error) { return recover(error); } }

export function both(x: { ok: boolean }) {
  if (!x.ok) {
    reject();
  }
  accept();
}

export function elseIf(x: number) {
  if (x === 1) a();
  else if (x === 2) b();
  else c();
}

export function optional(x: number | undefined, target: { y?: number }) {
  if (x) target.y = x;
  return use(1);
}

export function thrower(x: unknown) {
  if (!isValid(x)) throw new TokenError(TokenErrorCode.InvalidRequest, 'bad');
  return x;
}

export function kinds(kind: string) {
  switch (kind) {
    case 'a':
      return a();
    case 'b':
      b();
      break;
    default:
      throw new Error('kind');
  }
  return done();
}

export function loop(items: unknown[]) {
  for (const item of items) {
    store(item);
  }
}

export function callbacks(items: unknown[]) {
  return items.map((item) => store(item));
}

export function returnsObject(a: { id: string }, rest: object) {
  return { tokenClient: a, authenticatedClientId: a.id, ...rest };
}

export function comments() {
  a(); // trailing
  // RFC 6749 §5.2: the client must exist.
  b();
}

export function definitions() {
  function innerFunction() { a(); }
  const resolver = {
    async find(code: string) {
      return b();
    },
  };
  innerFunction;
  return resolver;
}

export function local(header: object, payload: object) {
  const encode = (value: object) => outer(inner(value));
  return \`\${encode(header)}.\${encode(payload)}\`;
}

export function enumThrow() {
  throw new TokenError(Kind.A, 'x');
}

export function trailing() {
  if (check()) {
    return a();
  }
  return b();
  // a comment after the last statement
}
`;

let fixture: Fixture;
beforeAll(() => {
  fixture = compile({ 'a.ts': SOURCE });
});
afterAll(() => fixture.dispose());

describe('the tree of a function', () => {
  it('should run the calls of a statement in order, the inner ones first as the pre of the outer one', () => {
    expect(callOrder(fixture.tree('sequence').tree.nodes)).toEqual(['parse', 'helper', 'build']);
    expect(outline(fixture.tree('sequence').tree)).toEqual(['s0 call const x = parse(a)', 's1 call helper(b)', '  s2i0 call build(x)', 's2 return return build(x)']);
    expect(callOrder(fixture.tree('nested').tree.nodes)).toEqual(['inner', 'outer']);
  });

  it('should end at an end node when the body runs out without a return, with the lines down to its brace', () => {
    const { tree } = fixture.tree('noReturn');
    expect(tree.nodes.map((node) => node.kind)).toEqual(['call', 'end']);
    // The blank line above the call is the call's.
    const [call, end] = tree.nodes;
    expect(call?.lines[0]).toBe(tree.head[1] + 1);
    expect(end?.lines[1]).toBe(tree.lines[1]);
  });

  it('should read a guard: the condition with its comment, the call in it before it, the side that ends at once', () => {
    const { tree } = fixture.tree('guard');
    const guard = tree.nodes[0];
    expect(guard?.kind).toBe('if');
    expect(guard?.form).toBe('guard');
    expect(guard?.text).toBe('Reject sessions older than the requested max_age.');
    expect(guard?.from).toBe('comment');
    expect(guard?.pre?.map((node) => node.code)).toEqual(['isCurrent(session)']);
    expect(guard?.branches?.find((branch) => branch.key === 'true')?.nodes.map((node) => node.kind)).toEqual(['return']);
    expect(guard?.branches?.find((branch) => branch.key === 'true')?.nodes[0]?.text).toBeUndefined();
  });

  it('should keep && in the condition of an if, with the calls it may make', () => {
    const { tree } = fixture.tree('shortCircuit');
    expect(tree.nodes[0]?.code).toBe('if (ok && check())');
    expect(callOrder(tree.nodes)).toEqual(['check', 'cached', 'fresh']);
  });

  it('should leave out the code no way reaches and count the returns', () => {
    const { tree } = fixture.tree('unreachable');
    expect([...nodesOf(tree.nodes)].filter((node) => node.kind === 'return')).toHaveLength(3);
    expect(tree.nodes.some((node) => node.kind === 'end')).toBe(false);
  });

  it.each([
    ['nullish', '??', ['defined', 'nullish'], 'nullish'],
    ['or', '||', ['true', 'false'], 'false'],
    ['and', '&&', ['true', 'false'], 'true'],
  ])('should make %s a cond-expr whose call runs on one side only', (name, operator, keys, side) => {
    const node = fixture.tree(name).tree.nodes[0];
    expect(node?.kind).toBe('cond-expr');
    expect(node?.operator).toBe(operator);
    expect(node?.subject).toBe('value');
    expect(node?.branches?.map((branch) => branch.key)).toEqual(keys);
    expect(node?.branches?.find((branch) => branch.key === side)?.nodes.map((child) => child.code)).toEqual(['fallback()']);
  });

  it('should make a conditional return two sides with a call each', () => {
    const node = fixture.tree('ternary').tree.nodes[0];
    expect(node?.kind).toBe('return');
    expect(node?.pre?.[0]?.kind).toBe('cond-expr');
    expect(node?.pre?.[0]?.branches?.map((branch) => branch.nodes.map((child) => child.code))).toEqual([['accept()'], ['reject()']]);
  });

  it('should read a try with its catch, and the error a throw throws with the value of its code', () => {
    const node = fixture.tree('tried').tree.nodes[0];
    expect(node?.kind).toBe('try');
    expect(node?.branches?.map((branch) => branch.key)).toEqual(['try', 'catch']);
    const thrown = node?.branches?.[0]?.nodes.find((child) => child.kind === 'throw');
    expect(thrown?.error).toBe('TokenError(invalid_request)');
    expect(fixture.tree('enumThrow').tree.nodes[0]?.error).toBe('TokenError(a_kind)');
  });

  it('should keep both sides of an if and its else-if chain', () => {
    expect(outline(fixture.tree('both').tree)).toEqual(['s0 if if (!x.ok)', '  [true]', '    s0t0 action reject()'.replace('action', 'call'), 's1 call accept()', 's2 end 終わり']);
    expect(outline(fixture.tree('elseIf').tree)).toEqual([
      's0 if if (x === 1)',
      '  [true]',
      '    s0t0 call a()',
      '  [false]',
      '    s0e0 if if (x === 2)',
      '      [true]',
      '        s0e0t0 call b()',
      '      [false]',
      '        s0e0e0 call c()',
      's1 end 終わり',
    ]);
  });

  it('should tell an optional item from a fork', () => {
    expect(fixture.tree('optional').tree.nodes[0]?.form).toBe('optional');
    expect(fixture.tree('both').tree.nodes[0]?.form).toBe('fork');
  });

  it('should branch a switch by its cases, with a default', () => {
    const node = fixture.tree('kinds').tree.nodes[0];
    expect(node?.kind).toBe('switch');
    expect(node?.branches?.map((branch) => branch.label)).toEqual(["case 'a'", "case 'b'", 'default']);
    expect(node?.branches?.map((branch) => branch.nodes.map((child) => child.kind))).toEqual([['return'], ['call', 'action'], ['throw']]);
  });

  it('should read a loop and a callback a call runs as loops', () => {
    expect(outline(fixture.tree('loop').tree)).toEqual(['s0 loop for (const item of items)', '  [body]', '    s0l0 call store(item)', 's1 end 終わり']);
    const callback = fixture.tree('callbacks').tree.nodes[0]?.pre?.[0];
    expect(callback?.kind).toBe('loop');
    expect(callback?.text).toBe('各要素で');
    expect(callback?.branches?.[0]?.nodes.map((child) => child.code)).toEqual(['store(item)']);
  });

  it('should name a returned object by its keys', () => {
    expect(fixture.tree('returnsObject').tree.nodes[0]?.code).toBe('return { tokenClient, authenticatedClientId, ...rest }');
  });

  it('should give a statement the comment above it, and a trailing comment to none', () => {
    expect(fixture.tree('comments').tree.nodes.map((node) => node.from === 'comment' ? node.text : undefined)).toEqual([undefined, 'RFC 6749 §5.2: the client must exist.', undefined]);
  });

  it('should not run what a nested function or a method of an object literal calls, and keep it as deferred', () => {
    const built = fixture.tree('definitions');
    expect(callOrder(built.tree.nodes)).toEqual([]);
    expect(built.tree.deferred).toEqual(['lib:a.ts#a', 'lib:a.ts#b']);
  });

  it('should run the body of a local function where it is called', () => {
    const { tree } = fixture.tree('local');
    expect(callOrder(tree.nodes)).toEqual(['inner', 'outer', 'inner', 'outer']);
    const inlined = tree.nodes[1]?.pre?.[0];
    expect(inlined?.kind).toBe('loop');
    expect(inlined?.text).toBe('`encode` の中で');
  });

  it('should cover every line of a body with its nodes, trailing comments included', () => {
    for (const name of ['sequence', 'guard', 'tried', 'kinds', 'trailing', 'local']) {
      const { tree } = fixture.tree(name);
      const covered = new Set(tree.nodes.flatMap((node) => Array.from({ length: node.lines[1] - node.lines[0] + 1 }, (_value, index) => node.lines[0] + index)));
      const body = Array.from({ length: tree.lines[1] - tree.head[1] - 1 }, (_value, index) => tree.head[1] + 1 + index);
      expect(body.filter((line) => !covered.has(line)), name).toEqual([]);
    }
  });

  it('should give every node an id from its position', () => {
    const ids = [...nodesOf(fixture.tree('elseIf').tree.nodes)].map((node) => node.id);
    expect(ids).toEqual(['s0', 's0t0', 's0e0', 's0e0t0', 's0e0e0', 's1']);
  });
});

describe('the members of interfaces and the request context', () => {
  const STORE = `
/** Where the consents are. */
export interface ConsentResolver {
  /** Record that the user consented. */
  recordConsent?(subject: string): Promise<void>;
  /** Whether the user consented. */
  hasConsent(subject: string): Promise<boolean>;
}
export interface Stores { consentResolver: ConsentResolver }
export function createConsentResolver(): ConsentResolver {
  return {
    async hasConsent(subject: string) { return subject !== ''; },
    async recordConsent(subject: string) { void subject; },
  };
}
export function setContext(c: any, stores: Stores) {
  c.set('consentResolver', stores.consentResolver);
}
export async function typed(resolver: ConsentResolver) {
  return resolver.hasConsent('s');
}
export async function fromContext(c: any) {
  const consentResolver = c.get('consentResolver');
  await consentResolver.recordConsent?.('s');
  const unknown = c.get('somethingElse');
  await unknown.run();
  c.json({});
}
export function audit(subject: string) { return subject; }
export function createAuditedResolver(inner: ConsentResolver): ConsentResolver {
  const check = (subject: string) => { audit(subject); return inner.hasConsent(subject); };
  return {
    async hasConsent(subject: string) { return check(subject); },
    async recordConsent(subject: string) { void subject; },
  };
}
`;
  let members: Fixture;
  beforeAll(() => {
    members = compile({ 'a.ts': STORE });
  });
  afterAll(() => members.dispose());

  it('should resolve a method call to the member of the interface its receiver is typed with', () => {
    expect(members.tree('typed').tree.nodes[0]?.pre?.[0]?.target).toEqual({ kind: 'member', id: 'lib:a.ts#ConsentResolver.hasConsent' });
    expect(members.revision.members.get('lib:a.ts#ConsentResolver.hasConsent')?.summary).toBe('Whether the user consented.');
  });

  it('should read a value of the request context by the type c.set() puts under its key, and say when it cannot', () => {
    const nodes = members.tree('fromContext').tree.nodes;
    expect(nodes[1]?.target).toEqual({ kind: 'member', id: 'lib:a.ts#ConsentResolver.recordConsent' });
    expect(nodes[3]?.target).toEqual({ kind: 'untraceable', why: "c.get('somethingElse') の型が分からない", method: 'run' });
    // A call of the framework on the context is no node.
    expect(nodes[4]?.kind).toBe('action');
  });

  it('should find the members an object literal implements', () => {
    expect(members.tree('createConsentResolver').tree.implements?.map((implementation) => implementation.member)).toEqual(['lib:a.ts#ConsentResolver.hasConsent', 'lib:a.ts#ConsentResolver.recordConsent']);
  });

  it('should keep what each implementation calls, through the functions the frame defines itself', () => {
    expect(members.tree('createAuditedResolver').tree.implements).toEqual([
      { member: 'lib:a.ts#ConsentResolver.hasConsent', lines: [33, 33], calls: ['lib:a.ts#audit', 'lib:a.ts#ConsentResolver.hasConsent'] },
      { member: 'lib:a.ts#ConsentResolver.recordConsent', lines: [34, 34] },
    ]);
  });
});

describe('the body of an endpoint', () => {
  const PIPELINE = `
export function parseRequest(c: unknown) { return { params: c }; }
export function dispatchExchange(params: unknown): Response | undefined { return params === undefined ? undefined : new Response(); }
export function validateRefresh(params: unknown): { kind: 'refresh' } | undefined { return params === 1 ? { kind: 'refresh' } : undefined; }
export function validateCode(params: unknown): { kind: 'code' } { void params; return { kind: 'code' }; }
export function respond(value: unknown) { return new Response(String(value)); }
export function respondError(error: unknown) { return new Response(String(error), { status: 400 }); }

declare const app: { post(path: string, handler: (c: unknown) => Promise<Response>): void };

app.post('/', async (c) => {
  try {
    // [parse-request] Parse the request — RFC 6749 §4.1.3
    const { params } = parseRequest(c);

    // [dispatch-exchange] (feature: token-exchange) Exchange a token — RFC 8693
    const exchanged = dispatchExchange(params);
    if (exchanged) return exchanged;

    // [validate-refresh] (feature: refresh-token) Validate refresh_token
    const refreshRequest = validateRefresh(params);

    // [validate-code] Validate authorization_code
    const validated = refreshRequest ?? validateCode(params);

    // [respond] Respond
    return respond(validated);
  } catch (error) {
    return respondError(error);
  }
});
`;
  let endpoint: Fixture;
  beforeAll(() => {
    endpoint = compile(
      { 'endpoints/token/pipeline.ts': PIPELINE },
      { endpoints: [{ source: 'lib', directory: 'endpoints', layout: 'hono', frameworks: ['hono'], endpoints: [{ id: 'token', label: 'Token', path: '/token', methods: ['POST'], layer: 'api', group: { id: 'g', label: 'g' }, rearrangeable: true, module: 'token/pipeline.ts', steps: [], edges: [] }] }] },
    );
  });
  afterAll(() => endpoint.dispose());

  it('should read the handler of a pipeline as the endpoint body, its markers as blocks with their features', () => {
    // The bodies of the Hono source are `endpoint:<id>`; those of another source carry its name.
    expect(endpoint.revision.endpointRoots.get('lib:token')).toBe('endpoint:lib:token');
    const built = endpoint.revision.trees.get('endpoint:lib:token');
    const attempt = built?.tree.nodes[0]?.branches?.find((branch) => branch.key === 'try');
    expect(attempt?.nodes.map((node) => [node.kind, node.step?.id, node.feature])).toEqual([
      ['block', 'parse-request', undefined],
      ['block', 'dispatch-exchange', 'token-exchange'],
      ['block', 'validate-refresh', 'refresh-token'],
      ['block', 'validate-code', undefined],
      ['block', 'respond', undefined],
    ]);
    expect(attempt?.nodes[0]?.step).toEqual({ id: 'parse-request', label: 'Parse the request', spec: 'RFC 6749 §4.1.3' });
    expect(built?.tree.name).toBe('POST /token');
  });

  it('should narrow a decision that reads the value of a block of a feature, and name the sides by where they go', () => {
    const built = endpoint.revision.trees.get('endpoint:lib:token');
    const attempt = built?.tree.nodes[0]?.branches?.find((branch) => branch.key === 'try');
    const guard = attempt?.nodes[1]?.branches?.[0]?.nodes[1];
    expect(guard?.absent).toEqual({ feature: 'token-exchange', side: 'false' });
    const choice = attempt?.nodes[3]?.branches?.[0]?.nodes[0];
    expect(choice?.kind).toBe('cond-expr');
    expect(choice?.absent).toEqual({ feature: 'refresh-token', side: 'nullish' });
    expect(choice?.branches?.map((branch) => [branch.key, branch.toward])).toEqual([
      ['defined', 'Validate refresh_token の値を使う'],
      ['nullish', 'Validate authorization_code へ'],
    ]);
  });
});

describe('the words of a condition', () => {
  const CONDITIONS = `
export function isPublic(client: { secret?: string }): boolean { return client.secret === undefined; }
export function lookup(key: string): string | undefined { return key; }
export function single(client: { secret?: string }) { if (isPublic(client)) return; throw new Error('x'); }
export function negated(client: { secret?: string }) { if (!(isPublic(client))) throw new Error('x'); }
export function compound(url: URL, client: { secret?: string }) { if (url.protocol !== 'https:' && !isPublic(client)) throw new Error('x'); }
export function value(key: string) { if (lookup(key)) return 1; return 2; }
export function either(length: number) { if (length < 43 || length > 128) throw new Error('x'); }
`;
  let conditions: Fixture;
  beforeAll(() => {
    conditions = compile({ 'a.ts': CONDITIONS }, { summaries: { 'lib:a.ts#isPublic': 'パブリッククライアントなら true を返す。', 'lib:a.ts#lookup': '鍵の値を返す。' } });
  });
  afterAll(() => conditions.dispose());

  it.each([
    ['single', 'パブリッククライアントか', 'doc'],
    ['negated', '「パブリッククライアント」が成り立たないか', 'doc'],
    ['either', 'length が 43 より小さい、または length が 128 より大きいか', 'code'],
  ])('should say what the condition of %s checks', (name, text, from) => {
    const node = conditions.tree(name).tree.nodes[0];
    expect([node?.text, node?.from]).toEqual([text, from]);
  });

  it.each(['compound', 'value'])('should not take the JSDoc of a call for the words of the condition of %s, which is more than that call or says no condition', (name) => {
    expect(conditions.tree(name).tree.nodes[0]?.text).toBeUndefined();
  });
});
