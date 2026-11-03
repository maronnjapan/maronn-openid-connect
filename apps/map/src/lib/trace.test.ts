import { describe, expect, it } from 'vitest';
import type { FlowTree, MapData, TreeNode } from '../types';
import { catcherOf, changeReach, choose, chosenSide, EMPTY_TRACE, foldedWords, frameIds, framesToChanges, nodesRun, traceRows, wayTo } from './trace';

const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee }, ...extra });
const returned = (id: string, code: string): TreeNode => ({ id, kind: 'return', lines: [3, 3], code });

/** The body of /token in small: a dispatch of a feature, a choice of the grant, a response, in a try. */
const root: FlowTree = {
  id: 'endpoint:token',
  name: 'POST /token',
  signature: 'POST /token',
  file: 'hono:pipeline.ts',
  lines: [1, 30],
  head: [1, 1],
  nodes: [
    {
      id: 's0',
      kind: 'try',
      lines: [2, 29],
      code: 'try … catch',
      subject: '例外',
      branches: [
        {
          key: 'try',
          label: '例外なし',
          nodes: [
            { id: 's0b0', kind: 'block', lines: [3, 5], code: '[dispatch]', step: { id: 'dispatch', label: 'Exchange', feature: 'token-exchange' }, feature: 'token-exchange', branches: [{ key: 'body', label: 'Exchange', nodes: [
              call('s0b0s0', 'exchange'),
              { id: 's0b0s1', kind: 'if', lines: [5, 5], code: 'if (exchanged)', subject: 'exchanged', form: 'guard', absent: { feature: 'token-exchange', side: 'false' }, branches: [{ key: 'true', label: '成立', nodes: [returned('s0b0s1t0', 'return exchanged')] }, { key: 'false', label: '不成立', nodes: [] }] },
            ] }] },
            { id: 's0b1', kind: 'cond-expr', lines: [6, 7], code: 'refresh ?? code()', subject: 'refresh', operator: '??', absent: { feature: 'refresh-token', side: 'nullish' }, branches: [{ key: 'defined', label: '値あり', nodes: [] }, { key: 'nullish', label: 'null または undefined', nodes: [call('s0b1n0', 'code')] }] },
            { id: 's0b2', kind: 'action', lines: [8, 8], code: 'const a = 1' },
            { id: 's0b3', kind: 'action', lines: [9, 9], code: 'const b = 2' },
            returned('s0b4', 'return respond()'),
          ],
        },
        { key: 'catch', label: '例外が起きたとき', nodes: [returned('s0h0', 'return respondError()')] },
      ],
    },
  ],
};
const code: FlowTree = { id: 'code', name: 'code', signature: 'code()', file: 'core:code.ts', lines: [1, 9], head: [1, 1], nodes: [call('s0', 'check'), returned('s1', 'return x')] };
const check: FlowTree = { id: 'check', name: 'check', signature: 'check()', file: 'core:check.ts', lines: [1, 9], head: [1, 1], nodes: [{ id: 's0', kind: 'throw', lines: [2, 2], code: 'throw TokenError(invalid_grant)', error: 'TokenError(invalid_grant)' }] };
const trees = new Map([['endpoint:token', root], ['code', code], ['check', check]]);

describe('the nodes a choice runs', () => {
  it('should run everything without a choice, and only the chosen side and what goes on after it with one', () => {
    expect(nodesRun(root, '', [], undefined).has('s0h0')).toBe(true);
    const caught = nodesRun(root, '', [{ s0: 'catch' }], undefined);
    expect(caught.has('s0h0')).toBe(true);
    expect(caught.has('s0b0')).toBe(false);
    const dispatched = nodesRun(root, '', [{ s0: 'try', 's0b0s1': 'true' }], undefined);
    expect(dispatched.has('s0b0s1t0')).toBe(true);
    expect(dispatched.has('s0b1')).toBe(false);
  });

  it('should take out the blocks of a feature that is off and keep the side of a decision where its value is missing', () => {
    const on = nodesRun(root, '', [], new Set<string>());
    expect(on.has('s0b0')).toBe(false);
    expect(on.has('s0b1n0')).toBe(true);
  });

  it('should union several choices', () => {
    const both = nodesRun(root, '', [{ s0: 'catch' }, { s0: 'try', s0b1: 'nullish' }], undefined);
    expect([both.has('s0h0'), both.has('s0b1n0'), both.has('s0b4')]).toEqual([true, true, true]);
  });

  it('should set a side in every choice and clear it, the choices going away when they choose nothing', () => {
    const chosen = choose([], 's0', 'catch');
    expect(chosen).toEqual([{ s0: 'catch' }]);
    expect(chosenSide(chosen, 's0')).toBe('catch');
    expect(choose(chosen, 's0', undefined)).toEqual([]);
  });

  it('should find the sides that lead to a node, the guards before it passed', () => {
    expect(wayTo(root, '', 's0b1n0')).toEqual({ s0: 'try', 's0b0s1': 'false', s0b1: 'nullish' });
    expect(wayTo(code, 's0b1n0', 's1')).toEqual({});
  });
});

describe('the frames of a trace', () => {
  const data = {
    functions: {
      code: { id: 'code', name: 'code', sites: [['s0', 'check']], frame: 'x', calls: ['check'] },
      check: { id: 'check', name: 'check', sites: [], frame: 'y', calls: [] },
    },
    bodies: { 'endpoint:token': { id: 'endpoint:token', name: 'POST /token', sites: [['s0b0s0', 'exchange'], ['s0b1n0', 'code']], frame: 'z', calls: ['code'] } },
    changes: { frames: [{ id: 'check', kind: 'modified', counts: { 'condition+': 1 }, reach: [] }] },
  } as unknown as MapData;

  it('should know the frame each opened key is, through the call nodes of the trees loaded', () => {
    expect([...frameIds('endpoint:token', ['s0b1n0', 's0b1n0.s0'], trees)]).toEqual([['', 'endpoint:token'], ['s0b1n0', 'code'], ['s0b1n0.s0', 'check']]);
  });

  it('should open every frame down to every change below, with no limit', () => {
    const reach = changeReach(data);
    expect(reach?.below('endpoint:token')).toEqual(new Set(['check']));
    expect(framesToChanges(data, reach!, 'endpoint:token')).toEqual(['s0b1n0', 's0b1n0.s0']);
  });

  it('should find the catch a failure of a call is caught by, up through the frames', () => {
    const ids = frameIds('endpoint:token', ['s0b1n0'], trees);
    expect(catcherOf(trees, ids, 's0b1n0', 's0')?.node.id).toBe('s0');
    expect(catcherOf(trees, ids, 's0b1n0', 's0')?.frame).toBe('');
  });
});

describe('the rows of the outline', () => {
  const rows = (open: string[], choices: Record<string, string>[] = [], enabled?: Set<string>) =>
    traceRows({ rootId: 'endpoint:token', hasFrame: (id) => id === 'code' || id === 'check', trees, state: { ...EMPTY_TRACE, open, choices }, ...(enabled === undefined ? {} : { enabled }) }).map((row) => {
      if (row.kind === 'node') return `${'  '.repeat(row.depth)}${row.node.code}${row.folded ? ` ${row.folded}` : ''}${row.frameState ? ` [${row.frameState}]` : ''}${row.on ? '' : ' (off)'}`;
      if (row.kind === 'branch') return `${'  '.repeat(row.depth)}└ ${row.branch.label}${row.folded ? `: ${row.folded}` : ''}`;
      if (row.kind === 'actions') return `${'  '.repeat(row.depth)}処理 ×${row.nodes.length}`;
      return `${'  '.repeat(row.depth)}${row.kind}`;
    });

  it('should indent the tree, fold a guard and a run of actions to one line, and open a frame below its call', () => {
    expect(rows(['s0b1n0'])).toEqual([
      'try … catch',
      '  └ 例外なし',
      '    [dispatch]',
      '      exchange()',
      '      if (exchanged) → return exchanged で終わる',
      '    refresh ?? code()',
      '      └ 値あり',
      '      └ null または undefined',
      '        code() [open]',
      '          check() [closed]',
      '          return x',
      '    処理 ×2',
      '    return respond()',
      '  └ 例外が起きたとき',
      '    return respondError()',
    ]);
  });

  it('should fold the side a choice does not take, and leave out the feature that is off', () => {
    expect(rows([], [{ s0: 'catch' }], new Set<string>())).toEqual([
      'try … catch',
      '  └ 例外なし: 処理 3、return respond() で終わる',
      '  └ 例外が起きたとき',
      '    return respondError()',
    ]);
  });

  it('should fold a side to its nodes in words', () => {
    expect(foldedWords([call('a', 'f'), returned('b', 'return x')])).toBe('呼び出し 1、return x で終わる');
    expect(foldedWords([])).toBe('何もしない');
  });
});
