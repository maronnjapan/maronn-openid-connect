import { describe, expect, it } from 'vitest';
import { escapingFailures } from '../failures.js';
import { CallGraph, reachOf } from '../impact.js';
import type { FlowTree, TreeNode } from '../model.js';
import { failureSelections, frameSelections, wayTo } from '../selections.js';
import { conditionWords, actionWords, bindingNames, joinLines } from '../words.js';

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
    // A failure that a call brings up is a way the frame ends, down to the throw, the try around the call left undecided so its catch shows.
    expect(failureSelections('caught', trees, failures, (id) => id)).toEqual([
      { kind: 'failure', name: '`TokenError(invalid_client)` で終わる（`leaf` から）', note: '→ throw TokenError(invalid_client)', decisions: { 's0b0.s0.s0': 'true' }, frames: ['s0b0', 's0b0.s0'], target: 's0b0.s0.s0t0', failure: { error: 'TokenError(invalid_client)', from: 'leaf', name: 'leaf' } },
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

describe('words', () => {
  it('should say what a condition checks from its code', () => {
    expect(conditionWords('expiresAt <= now')).toBe('expiresAt が now 以下か');
    expect(conditionWords('!client')).toBe('client が偽として評価されるか');
    expect(conditionWords("scope.includes('openid')")).toBe("scope に 'openid' が含まれるか");
    expect(conditionWords('hash !== undefined')).toBe('hash が あるか');
    expect(conditionWords('error instanceof TokenError')).toBe('error が TokenError 型の値か');
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
