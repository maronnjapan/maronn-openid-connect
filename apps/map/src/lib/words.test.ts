import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../types';
import { calleeSummary, firstSentence, nodeWords, sideWords, splitPre, type WordSource } from './words';

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
    expect(nodeWords(returned, source, call('s3i0', { kind: 'function', id: 'core:a.ts#respond' }))).toEqual({ text: 'トークンレスポンスを返す。', code: false, tag: '終わり' });
    expect(nodeWords(returned, source)).toEqual({ text: 'return respond(c, body)', code: true, tag: '終わり' });
    expect(nodeWords({ id: 's4', kind: 'throw', lines: [1, 1], code: 'throw new TokenError(…)', error: 'TokenError(invalid_client)' }, source)).toEqual({ text: '`TokenError(invalid_client)` を投げる', code: false, tag: '失敗' });
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

describe('the words of a side', () => {
  it('should read what a side does after an arrow: its calls, then how it ends', () => {
    const exit: TreeNode = { id: 't1', kind: 'return', lines: [1, 1], code: 'return respond()', pre: [call('t1i0', { kind: 'function', id: 'core:a.ts#respond' })] };
    expect(sideWords([call('t0', { kind: 'function', id: 'core:a.ts#authenticate' }), exit], source)).toBe('クライアントを認証し、認証したクライアントを返す、終わり: トークンレスポンスを返す');
    expect(sideWords([{ id: 't2', kind: 'return', lines: [1, 1], code: 'return exchanged' }], source)).toBe('終わり: `return exchanged`');
    expect(sideWords([], source)).toBe('何もしない');
  });
});
