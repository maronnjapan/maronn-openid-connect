import { describe, expect, it } from 'vitest';
import { escapingFailures } from '../failures.js';
import { CallGraph, catcherIn, reachOf } from '../impact.js';
import type { FlowTree, TreeNode } from '../model.js';
import { failureSelections, frameSelections, wayTo } from '../selections.js';
import { conditionWords, actionWords, bindingNames, joinLines, predicateWords } from '../words.js';

/** A tree of nodes written by hand. */
function tree(id: string, nodes: TreeNode[]): FlowTree {
  return { id, name: id, signature: `${id}()`, file: 'x', lines: [1, 20], head: [1, 1], nodes };
}
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee }, ...extra });
const thrown = (id: string, error: string): TreeNode => ({ id, kind: 'throw', lines: [3, 3], code: `throw ${error}`, error });
const returned = (id: string, code = 'return x'): TreeNode => ({ id, kind: 'return', lines: [4, 4], code });

describe('escapingFailures', () => {
  it('should gather the throws outside a catching try and the failures of the functions called outside one, over the calls', () => {
    const trees = new Map<string, FlowTree>([
      ['leaf', tree('leaf', [{ id: 's0', kind: 'if', lines: [2, 2], code: 'if (x)', subject: 'x', form: 'guard', branches: [{ key: 'true', label: '成立', nodes: [thrown('s0t0', 'TokenError(invalid_client)')] }, { key: 'false', label: '不成立', nodes: [] }] }, returned('s1')])],
      ['middle', tree('middle', [call('s0', 'leaf'), returned('s1')])],
      ['caught', tree('caught', [{ id: 's0', kind: 'try', lines: [2, 6], code: 'try … catch', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: [call('s0b0', 'middle')] }, { key: 'catch', label: '例外が起きたとき', nodes: [returned('s0h0')] }] }])],
      ['rethrown', tree('rethrown', [{ id: 's0', kind: 'try', lines: [2, 6], code: 'try … catch', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: [call('s0b0', 'leaf')] }, { key: 'catch', label: '例外が起きたとき', nodes: [{ ...thrown('s0h0', 'error'), rethrow: true }] }] }])],
    ]);
    const failures = escapingFailures(trees);
    expect(failures.get('middle')).toEqual([{ error: 'TokenError(invalid_client)', from: 'leaf' }]);
    expect(failures.get('caught')).toEqual([]);
    expect(failures.get('rethrown')).toEqual([{ error: 'TokenError(invalid_client)', from: 'leaf' }]);
    // A failure that a call brings up is a way the frame ends, down to the throw: each call on the way fails there, the try around the call left undecided.
    expect(failureSelections('caught', trees, failures, (id) => id)).toEqual([
      {
        kind: 'failure',
        name: '`TokenError(invalid_client)` で終わる（`leaf` から）',
        note: '→ throw TokenError(invalid_client)',
        decisions: { s0b0: 'fails', 's0b0.s0': 'fails', 's0b0.s0.s0': 'true' },
        frames: ['s0b0', 's0b0.s0'],
        target: 's0b0.s0.s0t0',
        failure: { error: 'TokenError(invalid_client)', from: 'leaf', name: 'leaf' },
      },
    ]);
    expect(failureSelections('leaf', trees, failures, (id) => id)).toEqual([]);
  });
});

describe('the ways to a node', () => {
  const guard: TreeNode = { id: 's0', kind: 'if', lines: [2, 2], code: 'if (exchanged)', subject: 'exchanged', form: 'guard', branches: [{ key: 'true', label: '成立', nodes: [returned('s0t0', 'return exchanged')] }, { key: 'false', label: '不成立', nodes: [] }] };
  const choice: TreeNode = { id: 's1', kind: 'cond-expr', lines: [3, 3], code: 'a ?? f()', subject: 'a', operator: '??', branches: [{ key: 'defined', label: '値あり', nodes: [] }, { key: 'nullish', label: 'null または undefined', nodes: [call('s1n0', 'f')] }] };
  const root = tree('root', [guard, choice, returned('s2', 'return respond()')]);

  it('should choose the side a node is in, and pass what could end the frame before it', () => {
    expect(wayTo(root.nodes, 's1n0')?.decisions).toEqual({ s0: 'false', s1: 'nullish' });
    expect(wayTo(root.nodes, 's0t0')?.decisions).toEqual({ s0: 'true' });
  });

  it('should name the exits by the sides they are inside of only', () => {
    expect(frameSelections(root).map((selection) => [selection.kind, selection.name, selection.decisions])).toEqual([
      ['exit', 'exchanged: 成立', { s0: 'true' }],
      ['exit', 'return respond()', { s0: 'false' }],
    ]);
  });

  it('should name two catches that end the same by what their tries run first', () => {
    const attempt = (id: string, callee: string): TreeNode => ({ id, kind: 'try', lines: [2, 6], code: 'try … catch', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: [call(`${id}b0`, callee)] }, { key: 'catch', label: '例外が起きたとき', nodes: [returned(`${id}h0`, 'return null')] }] });
    const parse = tree('parse', [attempt('s0', 'core:a.ts#decode'), attempt('s1', 'core:a.ts#split'), returned('s2', 'return value')]);
    expect(frameSelections(parse).map((selection) => selection.name)).toEqual(['`decode()` で例外が起きたとき', '`split()` で例外が起きたとき', 'return value']);
  });

  it('should name two catches whose tries call the same function first by the calls as they are written', () => {
    const attempt = (id: string, code: string): TreeNode => ({ id, kind: 'try', lines: [2, 6], code: 'try … catch', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: [call(`${id}b0`, 'core:a.ts#decode', { code })] }, { key: 'catch', label: '例外が起きたとき', nodes: [thrown(`${id}h0`, 'RequestObjectError')] }] });
    const parse = tree('parse', [attempt('s0', 'const header = decode(headerB64)'), attempt('s1', 'payload = decode(payloadB64)'), returned('s2', 'return payload')]);
    expect(frameSelections(parse).map((selection) => selection.name)).toEqual(['`decode(headerB64)` で例外が起きたとき', '`decode(payloadB64)` で例外が起きたとき', 'return payload']);
  });

  it('should find the ways from the endpoints to a changed node, through the frames between, with the decisions keyed by frame', () => {
    const trees = new Map<string, FlowTree>([
      ['root', root],
      ['f', tree('f', [call('s0', 'g'), returned('s1')])],
      ['g', tree('g', [{ id: 's0', kind: 'if', lines: [2, 2], code: 'if (y)', subject: 'y', form: 'fork', branches: [{ key: 'true', label: '成立', nodes: [call('s0t0', 'h')] }, { key: 'false', label: '不成立', nodes: [] }] }, returned('s1')])],
    ]);
    const graph = new CallGraph(trees, [{ source: 'hono', frameworks: ['hono'], endpoint: { id: 'token' }, root: 'root' }]);
    expect(reachOf(graph, { frame: 'g', node: 's0t0' })).toEqual([
      { source: 'hono', frameworks: ['hono'], endpoint: 'token', frames: ['s1n0', 's1n0.s0'], decisions: { s0: 'false', s1: 'nullish', 's1n0.s0.s0': 'true' }, via: ['f', 'g'], features: [], target: 's1n0.s0.s0t0' },
    ]);
    expect(reachOf(graph, { frame: 'root', node: 's2' })[0]).toMatchObject({ frames: [], target: 's2', decisions: { s0: 'false' } });
  });
});

describe('the ways through the members of interfaces', () => {
  const member = (id: string, callee: string): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'member', id: callee } });
  const RESOLVER = 'core:token.ts#CodeResolver.revoke';
  const STORAGE = 'hono:store.ts#CodeStorage.consume';
  const trees = new Map<string, FlowTree>([
    // An endpoint of each source reaches the core function that calls the resolver's member.
    ['endpoint:token', tree('endpoint:token', [{ id: 's0', kind: 'try', lines: [2, 6], code: 'try … catch', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: [call('s0b0', 'core:token.ts#consumeCode')] }, { key: 'catch', label: '例外が起きたとき', nodes: [call('s0h0', 'hono:errors.ts#respondTokenError')] }] }])],
    ['endpoint:nextjs:token', tree('endpoint:nextjs:token', [call('s0', 'core:token.ts#consumeCode')])],
    ['core:token.ts#consumeCode', tree('core:token.ts#consumeCode', [member('s0', RESOLVER), returned('s1')])],
    // The resolver of hono implements the member over its store, whose implementation changed; Next.js has its own.
    ['hono:resolvers.ts#createStoreResolvers', { ...tree('hono:resolvers.ts#createStoreResolvers', [returned('s0')]), implements: [{ member: RESOLVER, lines: [3, 5], calls: [STORAGE] }] }],
    ['nextjs:resolvers.ts#createStoreResolvers', { ...tree('nextjs:resolvers.ts#createStoreResolvers', [returned('s0')]), implements: [{ member: RESOLVER, lines: [3, 5], calls: ['nextjs:store.ts#CodeStorage.consume'] }] }],
    ['hono:stores.ts#createProviderStores', { ...tree('hono:stores.ts#createProviderStores', [returned('s0')]), implements: [{ member: STORAGE, lines: [3, 5] }] }],
  ]);
  const graph = new CallGraph(trees, [
    { source: 'hono', frameworks: ['hono', 'express'], endpoint: { id: 'token' }, root: 'endpoint:token' },
    { source: 'nextjs', frameworks: ['nextjs'], endpoint: { id: 'token' }, root: 'endpoint:nextjs:token' },
  ]);

  it('should reach every call of the member whose implementation calls a changed member, under the endpoints of the app the implementation is in', () => {
    expect(reachOf(graph, { member: STORAGE, root: 'hono' })).toEqual([
      { source: 'hono', frameworks: ['hono', 'express'], endpoint: 'token', frames: ['s0b0'], decisions: { s0: 'try' }, via: ['core:token.ts#consumeCode'], features: [], target: 's0b0.s0', through: [RESOLVER, STORAGE] },
    ]);
  });

  it('should reach the endpoints of every source from a change of a library, and of its own source from a change of an app', () => {
    expect(reachOf(graph, { frame: 'core:token.ts#consumeCode', node: 's0' }).map((way) => way.source)).toEqual(['hono', 'nextjs']);
    expect(reachOf(graph, { member: RESOLVER, root: 'nextjs' }).map((way) => way.source)).toEqual(['nextjs']);
  });

  it('should say where a new failure of a change is caught on each way, or that it leaves the endpoint', () => {
    const ways = reachOf(graph, { frame: 'core:token.ts#consumeCode', node: 's0' }, { failures: true });
    expect(ways.map((way) => [way.source, way.caught, way.escapes])).toEqual([
      ['hono', { frame: 'endpoint:token', name: 'endpoint:token', node: 's0', call: 'respondTokenError(…)' }, undefined],
      ['nextjs', undefined, true],
    ]);
    expect(catcherIn(trees.get('endpoint:token') as FlowTree, 's0h0')).toBeUndefined();
  });
});

describe('words', () => {
  it('should say what a condition checks from its code', () => {
    expect(conditionWords('expiresAt <= now')).toBe('expiresAt が now 以下か');
    expect(conditionWords('!client')).toBe('client が偽として評価されるか');
    expect(conditionWords("scope.includes('openid')")).toBe("scope に 'openid' が含まれるか");
    expect(conditionWords('hash !== undefined')).toBe('hash が あるか');
    expect(conditionWords('error instanceof TokenError')).toBe('error が TokenError 型の値か');
  });

  it.each([
    ['codeVerifier.length < 43 || codeVerifier.length > 128', 'codeVerifier.length が 43 より小さい、または codeVerifier.length が 128 より大きいか'],
    ["typeof request !== 'string' || request.length === 0", 'request の型が string でない、または request.length が 0 と等しいか'],
    ['jwk.alg && jwk.alg !== alg', 'jwk.alg が真として評価される、かつ jwk.alg が alg と異なるか'],
    ['expiration === undefined || expiration === null', 'expiration が 無いか'],
    ['(a < b)', 'a が b より小さいか'],
  ])('should read a chain of && or || part by part: %s', (condition, words) => {
    expect(conditionWords(condition)).toBe(words);
  });

  it.each([
    ['!Number.isInteger(byteLength) || byteLength <= 0'],
    ['a && b || c'],
    ['(a || b) && c'],
    ['value ?? fallback'],
    ['ok ? a : b'],
    ['items.filter((item) => item === 1).length'],
  ])('should say nothing of a condition it cannot read whole: %s', (condition) => {
    expect(conditionWords(condition)).toBe('');
  });

  it.each([
    ['パブリッククライアントなら true を返す。', false, 'パブリッククライアントか'],
    ['ホスト名がループバックを指すなら true を返す。', true, '「ホスト名がループバックを指す」が成り立たないか'],
    ['`act` クレームの形が正しければ true を返す。', false, '`act` クレームの形が正しいか'],
    ['PKCE の値が一つでも保存されていれば true を返す', true, '「PKCE の値が一つでも保存されている」が成り立たないか'],
    ['クレームの値が要求の条件に合えば true を返す。', false, 'クレームの値が要求の条件に合うか'],
    ['トークンが失効しているかを返す。', false, 'トークンが失効しているか'],
    ['サブジェクトのユーザーのクレームを返す。', false, ''],
  ])('should read the JSDoc of a predicate as what a condition checks: %s', (doc, negated, words) => {
    expect(predicateWords(doc, negated)).toBe(words);
  });

  it('should say what a declaration and an assignment do', () => {
    expect(actionWords('const { a, b: c, ...d } = x')).toBe('`a`、`c`、`d` を取り出す');
    expect(actionWords('const issuedAt = Math.floor(Date.now() / 1000)')).toBe('`issuedAt` を求める');
    expect(actionWords('target.y = x')).toBe('`target.y` に入れる');
    expect(bindingNames('{ a, b: { c }, ...rest }')).toEqual(['a', 'c', 'rest']);
  });

  it('should join the lines of a paragraph with no space between Japanese sentences and a space otherwise', () => {
    expect(joinLines('トレースにする。\n呼び出しを開ける。')).toBe('トレースにする。呼び出しを開ける。');
    expect(joinLines('reads `a`\n  and b')).toBe('reads `a` and b');
  });
});
