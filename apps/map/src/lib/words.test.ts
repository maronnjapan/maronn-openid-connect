import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../types';
import { boundNames, calleeSummary, firstSentence, nodeWords, returnedWords, returnsCall, runWords, sideLabel, sideWords, splitPre, type WordSource } from './words';

const source = {
  functions: {
    'core:a.ts#authenticate': { summary: 'クライアントを認証し、認証したクライアントを返す。続きの説明。' },
    'core:a.ts#respond': { summary: 'トークンレスポンスを返す。' },
    'core:a.ts#blank': { summary: '' },
  },
  members: { 'core:s.ts#Store.get': { summary: '`key` のトランザクションを返す。' } },
} as unknown as WordSource;

const call = (id: string, target: TreeNode['target'], extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [1, 1], code: `${id}()`, ...(target === undefined ? {} : { target }), ...extra });

describe('the words of a row', () => {
  it('should say what a call does with the first sentence of the JSDoc of what it reaches, a function or an interface member', () => {
    expect(nodeWords(call('a', { kind: 'function', id: 'core:a.ts#authenticate' }), source)).toEqual({ text: 'クライアントを認証し、認証したクライアントを返す。', code: false });
    expect(nodeWords(call('b', { kind: 'member', id: 'core:s.ts#Store.get' }), source)).toEqual({ text: '`key` のトランザクションを返す。', code: false });
  });

  it('should fall back to the comment above a call, and to its code when nothing says what it does', () => {
    expect(nodeWords(call('c', { kind: 'function', id: 'core:a.ts#blank' }, { text: '鍵を読み込む。理由。', from: 'comment' }), source)).toEqual({ text: '鍵を読み込む。', code: false });
    expect(nodeWords(call('d', undefined, { code: 'c.json(body)' }), source)).toEqual({ text: 'c.json(body)', code: true });
  });

  it('should take the words a person wrote for a statement and the code for one with none, rather than words made from the code', () => {
    expect(nodeWords({ id: 's0', kind: 'if', lines: [1, 1], code: 'if (!payload.iss)', text: '必須のクレームがあることを確かめる。', from: 'comment' }, source)).toEqual({ text: '必須のクレームがあることを確かめる。', code: false });
    expect(nodeWords({ id: 's1', kind: 'if', lines: [1, 1], code: 'if (!keys)', text: 'keys が偽として評価されるか', from: 'code' }, source)).toEqual({ text: 'if (!keys)', code: true });
    expect(nodeWords({ id: 's2', kind: 'action', lines: [1, 1], code: 'const  params =\n rawParams', text: '`params` を求める', from: 'code' }, source)).toEqual({ text: 'const params = rawParams', code: true });
  });

  it('should say how a return and a throw end the flow, with the JSDoc of the call a return answers with', () => {
    const returned: TreeNode = { id: 's3', kind: 'return', lines: [1, 1], code: 'return respond(c, body)' };
    expect(nodeWords(returned, source, call('s3i0', { kind: 'function', id: 'core:a.ts#respond' }, { code: 'respond(c, body)' }))).toEqual({ text: 'トークンレスポンスを返す。', code: false, tag: '終わり' });
    expect(nodeWords(returned, source)).toEqual({ text: 'return respond(c, body)', code: true, tag: '終わり' });
    expect(nodeWords({ id: 's3b', kind: 'return', lines: [1, 1], code: 'return { params, authorization }' }, source)).toEqual({ text: '`params`、`authorization` を返す', code: false, tag: '終わり' });
    expect(nodeWords({ id: 's4', kind: 'throw', lines: [1, 1], code: 'throw new TokenError(…)', error: 'TokenError(invalid_client)' }, source)).toEqual({ text: '`TokenError(invalid_client)` を投げる', code: false, tag: '失敗' });
  });

  it('should read a return of a value that holds a call as what it returns, not as the call', () => {
    const fromBase64 = call('s3i1', { kind: 'function', id: 'core:a.ts#respond' }, { code: 'fromBase64Url(hash)' });
    const object: TreeNode = { id: 's3', kind: 'return', lines: [1, 1], code: 'return { iterations, salt, hash }', pre: [fromBase64] };
    expect(nodeWords(object, source, fromBase64)).toEqual({ text: '`iterations`、`salt`、`hash` を返す', code: false, tag: '終わり' });
    expect(splitPre(object)).toEqual({ others: [fromBase64] });
  });

  it('should give a return in a callback no end, since it ends the callback and not the frame', () => {
    const local: TreeNode = { id: 's0l2', kind: 'return', lines: [1, 1], code: 'return exportPublicJwk(key)', local: true };
    expect(nodeWords(local, source, call('s0l2i0', { kind: 'function', id: 'core:a.ts#respond' }, { code: 'exportPublicJwk(key)' }))).toEqual({ text: 'トークンレスポンスを返す。', code: false });
    expect(sideWords([{ id: 's0l3', kind: 'return', lines: [1, 1], code: 'return key', local: true }], source)).toBe('`key` を返す');
  });

  it('should name a step by its label and keep the words of a branching expression', () => {
    expect(nodeWords({ id: 's5', kind: 'block', lines: [1, 3], code: '[parse]', step: { id: 'parse', label: 'リクエストを解析する' } }, source).text).toBe('リクエストを解析する');
    expect(nodeWords({ id: 's6', kind: 'cond-expr', lines: [1, 1], code: 'a ?? f()', text: 'a が無ければ f() を呼ぶ', from: 'code' }, source)).toEqual({ text: 'a が無ければ f() を呼ぶ', code: false });
  });

  it('should take the first sentence of a text on one line', () => {
    expect(firstSentence('一つ目の文。\n二つ目の文。')).toBe('一つ目の文。');
    expect(firstSentence('句点の無い\n説明')).toBe('句点の無い 説明');
    expect(calleeSummary(call('e', { kind: 'untraceable', why: '型が無い' }), source)).toBeUndefined();
  });
});

describe('the calls before a statement', () => {
  it('should give a condition the call evaluated last, keep the calls before it apart, and give a call nothing', () => {
    const inner = call('s0i0', { kind: 'function', id: 'core:a.ts#blank' });
    const outer = call('s0i1', { kind: 'function', id: 'core:a.ts#authenticate' });
    expect(splitPre({ id: 's0', kind: 'if', lines: [1, 1], code: 'if (!outer(inner()))', pre: [inner, outer] })).toEqual({ call: outer, others: [inner] });
    expect(splitPre({ ...outer, id: 's1', pre: [inner] })).toEqual({ others: [inner] });
    expect(splitPre({ id: 's2', kind: 'return', lines: [1, 1], code: 'return x' })).toEqual({ others: [] });
  });
});

describe('a return that returns a call', () => {
  const returning = (code: string) => ({ id: 's0', kind: 'return' as const, lines: [1, 1] as [number, number], code });

  it('should take a return of the call itself, awaited or shortened, as returning it', () => {
    expect(['return f(x)', 'return await f(x)', 'return f(x, …)', 'return f(`a)b`, c)'].map((code) => returnsCall(returning(code), call('s0i0', undefined, { code: 'f(x)' })))).toEqual([true, true, true, true]);
  });

  it('should not take a value the call is only a part of as returning it', () => {
    expect(['return { a: f(x) }', 'return [...f(x)]', 'return f(x).y', 'return g(f(x))'].map((code) => returnsCall(returning(code), call('s0i0', undefined, { code: 'f(x)' })))).toEqual([false, false, false, false]);
  });
});

describe('the label of a side', () => {
  const side = (key: string, label: string, callee?: string) => ({ key, label, nodes: callee === undefined ? [] : [call(`s0${key}s0`, { kind: 'function', id: `nextjs:app/userinfo/route.ts#${callee}` })] });

  it('should keep a label no other side has', () => {
    const node: TreeNode = { id: 's0', kind: 'if', lines: [1, 1], code: 'if (x)', branches: [side('true', '成立'), side('false', '不成立')] };
    expect((node.branches ?? []).map((branch) => sideLabel(node, branch))).toEqual(['成立', '不成立']);
  });

  it('should tell the handlers of a Route Handler apart by their export, and other sides alike by their place', () => {
    const handlers: TreeNode = { id: 's0', kind: 'switch', lines: [1, 1], code: 'どのリクエストか', branches: [side('c0', 'GET | POST /userinfo', 'GET'), side('c1', 'GET | POST /userinfo', 'POST')] };
    const plain: TreeNode = { id: 's1', kind: 'switch', lines: [1, 1], code: 'kind', branches: [side('c0', 'case a'), side('c1', 'case a')] };
    expect([...(handlers.branches ?? []).map((branch) => sideLabel(handlers, branch)), ...(plain.branches ?? []).map((branch) => sideLabel(plain, branch))]).toEqual(['GET /userinfo', 'POST /userinfo', 'case a（1）', 'case a（2）']);
  });
});

describe('the words of a side', () => {
  it('should read what a side does after an arrow: its calls, then how it ends', () => {
    const exit: TreeNode = { id: 't1', kind: 'return', lines: [1, 1], code: 'return respond()', pre: [call('t1i0', { kind: 'function', id: 'core:a.ts#respond' }, { code: 'respond()' })] };
    expect(sideWords([call('t0', { kind: 'function', id: 'core:a.ts#authenticate' }), exit], source)).toBe('クライアントを認証し、認証したクライアントを返す、終わり: トークンレスポンスを返す');
    expect(sideWords([{ id: 't2', kind: 'return', lines: [1, 1], code: 'return exchanged' }], source)).toBe('終わり: `exchanged` を返す');
    expect(sideWords([{ id: 't3', kind: 'return', lines: [1, 1], code: 'return a + b' }], source)).toBe('終わり: `return a + b`');
    expect(sideWords([], source)).toBe('何もしない');
  });
});

describe('the words made from simple code', () => {
  it('should find the names a declaration binds and the target an assignment sets', () => {
    expect(boundNames('const { a, b: c, ...d } = x')).toEqual({ declared: ['a', 'c', 'd'], assigned: [] });
    expect(boundNames('const [first, { second }] = pairs')).toEqual({ declared: ['first', 'second'], assigned: [] });
    expect(boundNames('let duplicateKey')).toEqual({ declared: ['duplicateKey'], assigned: [] });
    expect(boundNames('const issuedAt: number = Math.floor(Date.now() / 1000)')).toEqual({ declared: ['issuedAt'], assigned: [] });
    expect(boundNames('rawParams[key] = value')).toEqual({ declared: [], assigned: ['rawParams[key]'] });
    expect(boundNames('seen.add(key)')).toEqual({ declared: [], assigned: [] });
    expect(boundNames('if (a === b)')).toEqual({ declared: [], assigned: [] });
  });

  it('should say what a return returns when its code is a name or an object of names, and nothing for anything else', () => {
    expect(returnedWords('return { tokenClient, authenticatedClientId }')).toBe('`tokenClient`、`authenticatedClientId` を返す');
    expect(returnedWords('return { ...params, scope: granted }')).toBe('`...params`、`scope` を返す');
    expect(returnedWords('return exchanged')).toBe('`exchanged` を返す');
    expect(returnedWords('return')).toBe('ここで終わる');
    expect(returnedWords('return a + b')).toBeUndefined();
  });

  it('should read a run of statements as what they bind, what they set, or both with the rest as code', () => {
    const action = (id: string, code: string): TreeNode => ({ id, kind: 'action', lines: [1, 1], code });
    expect(runWords([action('a', 'const config = c.get("config")'), action('b', 'const { a, b } = input')])).toEqual({ text: '`config`、`a`、`b` を用意する', code: false });
    expect(runWords([action('c', 'target.y = x')])).toEqual({ text: '`target.y` に入れる', code: false });
    expect(runWords([action('d', 'seen.add(key)'), action('e', 'rawParams[key] = value')])).toEqual({ text: '処理: `rawParams[key]`、`seen.add(key)`', code: false });
  });
});
