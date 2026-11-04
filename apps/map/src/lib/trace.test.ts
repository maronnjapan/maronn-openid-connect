import { describe, expect, it } from 'vitest';
import type { FlowTree, MapData, TreeNode } from '../types';
import { catcherOf, changeReach, choose, chosenSide, EMPTY_TRACE, FAILS, foldsGuard, frameIds, frameOrder, framesToChanges, nodesRun, rowFor, runsFor, shownFrame, sourceOf, stepCall, stepHolds, traceRows, wayTo, withinFrame, type Row } from './trace';
import type { FrameChange } from '../types';

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

describe('a call the choice makes fail', () => {
  it('should run the call, turn the rest of its list off, and run the catch of the try around it, after which the frame ends with the catch', () => {
    const failed = nodesRun(root, '', [{ s0b1: 'nullish', s0b1n0: FAILS }], undefined);
    expect(['s0b1n0', 's0b2', 's0b4', 's0h0'].map((id) => failed.has(id))).toEqual([true, false, false, true]);
  });

  it('should run the catch even when the choice takes the try side, since the call fails whatever it chooses', () => {
    const failed = nodesRun(root, '', [{ s0: 'try', s0b1: 'nullish', s0b1n0: FAILS }], undefined);
    expect(['s0b2', 's0h0'].map((id) => failed.has(id))).toEqual([false, true]);
  });

  it('should end the frame at the call when no try catches it there', () => {
    const failed = nodesRun(code, 's0b1n0', [{ 's0b1n0.s0': FAILS }], undefined);
    expect(['s0', 's1'].map((id) => failed.has(id))).toEqual([true, false]);
  });

  it('should stop a statement whose condition calls the call that fails', () => {
    const guarded: FlowTree = {
      ...code,
      id: 'guarded',
      nodes: [{ id: 's0', kind: 'if', lines: [2, 2], code: 'if (!isX(y(z)))', form: 'guard', pre: [call('s0i0', 'y'), call('s0i1', 'code')], branches: [{ key: 'true', label: '成立', nodes: [returned('s0t0', 'return no')] }, { key: 'false', label: '不成立', nodes: [] }] }, returned('s1', 'return yes')],
    };
    const failed = nodesRun(guarded, '', [{ s0i1: FAILS }], undefined);
    expect(['s0i0', 's0i1', 's0', 's0t0', 's1'].map((id) => failed.has(id))).toEqual([true, true, true, false, false]);
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

  it('should take a frame and the frames opened below it as within it, but not the frame of a call whose key only starts the same', () => {
    expect(['s2b6s0', 's2b6s0.s1', 's2b6s0.s1.s0', 's2b6s0i0', 's2b6s0i0.s1', 's2b6', ''].map((key) => withinFrame(key, 's2b6s0'))).toEqual([true, true, true, false, false, false, false]);
    expect(['s2b6s0i0', ''].map((key) => withinFrame(key, ''))).toEqual([true, true]);
  });

  it('should open every frame down to every change below, with no limit', () => {
    const reach = changeReach(data);
    expect(reach?.below('endpoint:token')).toEqual(new Set(['check']));
    expect(framesToChanges(data, reach!, 'endpoint:token')).toEqual(['s0b1n0', 's0b1n0.s0']);
  });

  it('should reach the changed implementation of a member through what the implementations of another member call, for the source shown alone', () => {
    const members = {
      functions: { 'core:a.ts#top': { id: 'core:a.ts#top', name: 'top', sites: [['s0', 'core:r.ts#Resolver.revoke']], frame: 'x', calls: [] } },
      bodies: {},
      members: { 'core:r.ts#Resolver.revoke': { id: 'core:r.ts#Resolver.revoke', calls: ['core:s.ts#Store.consume'] }, 'core:s.ts#Store.consume': { id: 'core:s.ts#Store.consume' } },
      changes: {
        frames: [
          { id: 'hono:stores.ts#createStores', kind: 'modified', counts: { 'call+': 1 }, reach: [], members: ['core:s.ts#Store.consume'] },
          { id: 'nextjs:stores.ts#createStores', kind: 'modified', counts: { 'call+': 1 }, reach: [], members: ['core:s.ts#Store.consume'] },
        ],
      },
    } as unknown as MapData;
    expect([...(changeReach(members, 'hono')?.below('core:a.ts#top') ?? [])]).toEqual(['hono:stores.ts#createStores']);
    expect([...(changeReach(members, 'nextjs')?.below('core:r.ts#Resolver.revoke') ?? [])]).toEqual(['nextjs:stores.ts#createStores']);
    expect(changeReach(members)?.below('core:a.ts#top').size).toBe(2);
    expect(changeReach(members, 'hono')?.implementers('core:s.ts#Store.consume')).toEqual(['hono:stores.ts#createStores']);
  });

  it('should say which members an implementation is reached through, and reach a frame a call reaches whole', () => {
    const members = {
      functions: {
        'core:a.ts#top': { id: 'core:a.ts#top', name: 'top', sites: [['s0', 'core:r.ts#Resolver.revoke'], ['s1', 'hono:stores.ts#createStores']], frame: 'x', calls: [] },
        'core:a.ts#mid': { id: 'core:a.ts#mid', name: 'mid', sites: [['s0', 'core:r.ts#Resolver.revoke']], frame: 'y', calls: [] },
      },
      bodies: {},
      members: { 'core:r.ts#Resolver.revoke': { id: 'core:r.ts#Resolver.revoke', calls: ['core:s.ts#Store.consume'] }, 'core:s.ts#Store.consume': { id: 'core:s.ts#Store.consume' } },
      changes: { frames: [{ id: 'hono:stores.ts#createStores', kind: 'modified', counts: { 'call+': 1 }, reach: [], members: ['core:s.ts#Store.consume'] }] },
    } as unknown as MapData;
    const reach = changeReach(members, 'hono');
    expect([...(reach?.parts('core:a.ts#mid') ?? [])]).toEqual([['hono:stores.ts#createStores', new Set(['core:s.ts#Store.consume'])]]);
    expect([...(reach?.parts('core:a.ts#top') ?? [])]).toEqual([['hono:stores.ts#createStores', undefined]]);
  });

  it('should run the code of an app root for its own source alone, and that of a package for every source', () => {
    expect([runsFor('hono:a.ts#f', 'hono'), runsFor('hono:a.ts#f', 'nextjs'), runsFor('nextjs:a.ts#f', 'nextjs'), runsFor('core:a.ts#f', 'nextjs'), runsFor('google-login:a.ts#f', 'hono'), runsFor('hono:a.ts#f', undefined)]).toEqual([true, false, true, true, true, true]);
    expect(['hono', 'express', 'fastify', 'nextjs'].map(sourceOf)).toEqual(['hono', 'hono', 'hono', 'nextjs']);
  });

  it('should find the catch a failure of a call is caught by, up through the frames', () => {
    const ids = frameIds('endpoint:token', ['s0b1n0'], trees);
    expect(catcherOf(trees, ids, 's0b1n0', 's0')?.node.id).toBe('s0');
    expect(catcherOf(trees, ids, 's0b1n0', 's0')?.frame).toBe('');
  });
});

describe('the rows of the outline', () => {
  /** A row as a line: its code, its state, and whether the choices run it. */
  const shown = (row: Row): string => {
    const pad = '  '.repeat('depth' in row ? row.depth : 0);
    if (row.kind === 'node') {
      const step = row.step === undefined ? '' : row.step.merged ? ' {step of one call}' : row.step.open ? ' {step open}' : ' {step folded}';
      const exit = row.exit === undefined ? '' : ` → ${row.exit.nodes.map((node) => node.code).join(', ')}${row.exit.on ? '' : ' (exit off)'}`;
      return `${pad}${row.node.code}${step}${row.frameState ? ` [${row.frameState}]` : ''}${exit}${row.on ? '' : ' (off)'}`;
    }
    if (row.kind === 'branch') return `${pad}└ ${row.branch.label}${row.exit === undefined ? '' : ` → ${row.exit.nodes.map((node) => node.code).join(', ')}`}${row.chosen ? ' (chosen)' : ''}${row.on ? '' : ' (off)'}`;
    return `${pad}${row.kind}`;
  };
  const rows = (open: string[], choices: Record<string, string>[] = [], enabled?: Set<string>, toggled: string[] = []) =>
    traceRows({ rootId: 'endpoint:token', hasFrame: (id) => id === 'code' || id === 'check', trees, state: { ...EMPTY_TRACE, open, choices }, toggled: new Set(toggled), ...(enabled === undefined ? {} : { enabled }) }).map(shown);

  it('should indent the tree, fold a step to its label, head the rows a try guards and follow them with its catch, and open a frame below its call', () => {
    expect(rows(['s0b1n0'])).toEqual([
      'try … catch',
      '  [dispatch] {step folded}',
      '  refresh ?? code()',
      '    └ 値あり',
      '    └ null または undefined',
      '      code() [open]',
      '        check() [closed]',
      '        return x',
      '  const a = 1',
      '  const b = 2',
      '  return respond()',
      '└ 例外が起きたとき → return respondError()',
    ]);
  });

  it('should keep the rows of the sides a choice does not take and turn them off, and leave out the feature that is off', () => {
    expect(rows([], [{ s0: 'catch' }], new Set<string>())).toEqual([
      'try … catch',
      '  refresh ?? code() (off)',
      '    └ null または undefined (chosen) (off)',
      '      code() [closed] (off)',
      '  const a = 1 (off)',
      '  const b = 2 (off)',
      '  return respond() (off)',
      '└ 例外が起きたとき → return respondError() (chosen)',
    ]);
  });

  it('should open a step the reader opens, read a guard on one line, and turn its exit off when the choice passes it', () => {
    expect(rows([], [], undefined, ['|s0b0']).slice(1, 4)).toEqual(['  [dispatch] {step open}', '    exchange()', '    if (exchanged) → return exchanged']);
    expect(rows([], [{ s0b0s1: 'false' }])[3]).toBe('    if (exchanged) → return exchanged (exit off)');
  });

  it('should open a step that holds a choice without being asked, and fold it again when the reader does', () => {
    expect(rows([], [{ s0b0s1: 'true' }])[1]).toBe('  [dispatch] {step open}');
    expect(rows([], [{ s0b0s1: 'true' }], undefined, ['|s0b0'])[1]).toBe('  [dispatch] {step folded}');
  });

  it('should read two statements in a row that say nothing in words as one line when asked, and each once the reader opens them', () => {
    const fold = (toggled: string[]) => traceRows({ rootId: 'endpoint:token', hasFrame: (id) => id === 'code' || id === 'check', trees, state: EMPTY_TRACE, foldCode: true, toggled: new Set(toggled) });
    expect(fold([]).map(shown).slice(6)).toEqual(['  run', '  return respond()', '└ 例外が起きたとき → return respondError()']);
    expect(fold(['|run|s0b2']).map(shown).slice(6, 9)).toEqual(['  run', '    const a = 1', '    const b = 2']);
    expect(rowFor(fold([]), '', 's0b3')).toBe('|run|s0b2');
    expect(rowFor(fold(['|run|s0b2']), '', 's0b3')).toBe('|s0b3');
  });

  it('should read a step of one call as that call, opening its frame below the step', () => {
    const single: FlowTree = { ...code, id: 'single', nodes: [{ id: 's0', kind: 'block', lines: [1, 2], code: '[issue]', step: { id: 'issue', label: '発行する' }, branches: [{ key: 'body', label: '発行する', nodes: [call('s0s0', 'code')] }] }] };
    const lines = traceRows({ rootId: 'single', hasFrame: (id) => id === 'code' || id === 'check', trees: new Map([...trees, ['single', single]]), state: { ...EMPTY_TRACE, open: ['s0s0'] } }).map(shown);
    expect(lines).toEqual(['[issue] {step of one call} [open]', '  check() [closed]', '  return x']);
  });

  it('should give a condition the call evaluated last before it, and keep the calls before that on rows of their own', () => {
    const guarded: FlowTree = {
      ...code,
      id: 'guarded',
      nodes: [{ id: 's0', kind: 'if', lines: [2, 2], code: 'if (!isX(y(z)))', form: 'guard', pre: [call('s0i0', 'y'), call('s0i1', 'code')], branches: [{ key: 'true', label: '成立', nodes: [returned('s0t0', 'return no')] }, { key: 'false', label: '不成立', nodes: [] }] }],
    };
    const found = traceRows({ rootId: 'guarded', hasFrame: (id) => id === 'code' || id === 'check', trees: new Map([...trees, ['guarded', guarded]]), state: EMPTY_TRACE });
    expect(found.map(shown)).toEqual(['y()', 'if (!isX(y(z))) [closed] → return no']);
    expect(found.map((row) => (row.kind === 'node' ? [row.before, row.call?.id] : []))).toEqual([[true, undefined], [false, 's0i1']]);
  });
});

describe('the row that shows a node', () => {
  const outline = (open: string[], choices: Record<string, string>[] = [], toggled: string[] = []) =>
    traceRows({ rootId: 'endpoint:token', hasFrame: (id) => id === 'code' || id === 'check', trees, state: { ...EMPTY_TRACE, open, choices }, toggled: new Set(toggled) });

  it('should give a node on a row of its own that row, in the root and in a frame opened below a call', () => {
    const rows = outline(['s0b1n0']);
    expect(rowFor(rows, '', 's0b4')).toBe('|s0b4');
    expect(rowFor(rows, '', 's0b1')).toBe('|s0b1');
    expect(rowFor(rows, 's0b1n0', 's1')).toBe('s0b1n0|s1');
  });

  it('should give a node inside a folded step the row of the step, and its own row once the step is open', () => {
    expect(rowFor(outline([]), '', 's0b0s0')).toBe('|s0b0');
    expect(rowFor(outline([], [], ['|s0b0']), '', 's0b0s0')).toBe('|s0b0s0');
  });

  it('should give a node inside a guard read on one line the row of the guard', () => {
    expect(rowFor(outline([], [], ['|s0b0']), '', 's0b0s1t0')).toBe('|s0b0s1');
  });

  it('should give a node on a side the choice does not take its own row, which stays', () => {
    expect(rowFor(outline([], [{ s0b1: 'defined' }]), '', 's0b1n0')).toBe('|s0b1n0');
    expect(rowFor(outline([], [{ s0: 'catch' }]), '', 's0b4')).toBe('|s0b4');
  });

  it('should give no row for a frame the outline does not show (unknown or closed), and a row for one opened below a side the choice does not take', () => {
    expect(rowFor(outline([]), 'nowhere', 's0')).toBeUndefined();
    expect(rowFor(outline([]), 's0b1n0', 's1')).toBeUndefined();
    expect(rowFor(outline(['s0b1n0'], [{ s0: 'catch' }]), 's0b1n0', 's1')).toBe('s0b1n0|s1');
  });
});

describe('the rules the outline and the diagram fold by', () => {
  const step = (body: TreeNode[]): TreeNode => ({ id: 's0', kind: 'block', lines: [1, 3], code: '[issue]', step: { id: 'issue', label: '発行する' }, branches: [{ key: 'body', label: '発行する', nodes: body }] });
  const framed = (id: string) => id === 'code';

  it('should read a step as its call only when its body is exactly one call of a function with a frame', () => {
    expect(stepCall(step([call('s0s0', 'code')]), undefined, framed)?.id).toBe('s0s0');
    expect([
      stepCall(step([call('s0s0', 'other')]), undefined, framed),
      stepCall(step([call('s0s0', 'code', { pre: [call('s0s0i0', 'code')] })]), undefined, framed),
      stepCall(step([call('s0s0', 'code'), returned('s0s1', 'return x')]), undefined, framed),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('should hold a step open for a change, a frame opened below it or a choice inside it, and for nothing else', () => {
    const block = root.nodes[0]?.branches?.[0]?.nodes[0] as TreeNode;
    expect([
      stepHolds('', block, { open: ['s0b0s0'], choices: [] }, []),
      stepHolds('', block, { open: [], choices: [{ s0b0s1: 'true' }] }, []),
      stepHolds('', block, { open: [], choices: [] }, ['s0b0s1t0']),
      stepHolds('', block, { open: ['s0b1n0'], choices: [{ s0b1: 'nullish' }] }, ['s0b1']),
      stepHolds('k', block, { open: ['s0b0s0'], choices: [] }, []),
    ]).toEqual([true, true, true, false, false]);
  });

  it('should fold a guard that calls no function with a frame and changed nowhere, and unfold one that does', () => {
    const guard = (side: TreeNode[]): TreeNode => ({ id: 's1', kind: 'if', lines: [2, 2], code: 'if (!x)', form: 'guard', branches: [{ key: 'true', label: '成立', nodes: side }, { key: 'false', label: '不成立', nodes: [] }] });
    const answers = guard([returned('s1t0', 'return respond(c)')]);
    const calls = guard([{ ...returned('s1t0', 'return code(c)'), pre: [call('s1t0i0', 'code')] }]);
    expect([
      foldsGuard(answers, undefined, framed, () => false),
      foldsGuard(calls, undefined, framed, () => false),
      foldsGuard(calls, undefined, () => false, () => false),
      foldsGuard(answers, undefined, framed, (id) => id === 's1t0'),
    ]).toEqual([true, false, true, false]);
  });
});

describe('the rows of the outline in a trace with failures and changes', () => {
  const options = { rootId: 'endpoint:token', hasFrame: (id: string) => id === 'code' || id === 'check', trees };

  it('should unfold a guard whose true side calls a function with a frame, so the call has its own row that opens it', () => {
    const calling: FlowTree = { ...code, id: 'calling', nodes: [{ id: 's0', kind: 'if', lines: [2, 2], code: 'if (!x)', form: 'guard', branches: [{ key: 'true', label: '成立', nodes: [call('s0t0', 'code')] }, { key: 'false', label: '不成立', nodes: [] }] }] };
    const lines = traceRows({ ...options, rootId: 'calling', trees: new Map([...trees, ['calling', calling]]), state: { ...EMPTY_TRACE, open: ['s0t0'] } });
    expect(lines.map((row) => [row.kind, row.key, (row as { frameState?: string }).frameState])).toEqual([
      ['node', '|s0', undefined],
      ['branch', '|s0|true', undefined],
      ['node', '|s0t0', 'open'],
      ['node', 's0t0|s0', 'closed'],
      ['node', 's0t0|s1', undefined],
    ]);
  });

  it('should give a folded step what it holds and how it ends, and an open one its own node alone', () => {
    const lines = traceRows({ ...options, state: EMPTY_TRACE });
    const folded = lines.find((row) => row.key === '|s0b0') as Extract<Row, { kind: 'node' }>;
    const opened = traceRows({ ...options, state: EMPTY_TRACE, toggled: new Set(['|s0b0']) }).find((row) => row.key === '|s0b0') as Extract<Row, { kind: 'node' }>;
    expect([folded.holds, folded.calls, folded.step?.exits.map((exit) => exit.node.id)]).toEqual([['s0b0', 's0b0s0', 's0b0s1', 's0b0s1t0'], ['exchange'], ['s0b0s1t0']]);
    expect([opened.holds, opened.step?.exits]).toEqual([['s0b0'], []]);
  });

  it('should say on its row that the choice makes a call fail, and turn the rows after it off', () => {
    const lines = traceRows({ ...options, state: { ...EMPTY_TRACE, choices: [{ s0b1: 'nullish', s0b1n0: FAILS }] } });
    const nodes = lines.filter((row): row is Extract<Row, { kind: 'node' }> => row.kind === 'node');
    expect(nodes.filter((row) => row.fails === true).map((row) => row.key)).toEqual(['|s0b1n0']);
    expect(nodes.filter((row) => !row.on).map((row) => row.key)).toEqual(['|s0b2', '|s0b3', '|s0b4']);
  });

  it('should read a catch that ends at once on one line naming the step it holds, and show its rows once the step opens, as the diagram does', () => {
    const answer: TreeNode = { id: 's1h0', kind: 'block', lines: [6, 8], code: '[respond-error]', step: { id: 'respond-error', label: 'Answer the error' }, branches: [{ key: 'body', label: 'Answer the error', nodes: [{ id: 's1h0s0', kind: 'action', lines: [7, 7], code: 'const body = toBody(error)' }, returned('s1h0s1', 'return respondError(body)')] }] };
    const guarded: FlowTree = { ...code, id: 'guarded', nodes: [call('s0', 'check'), { id: 's1', kind: 'try', lines: [3, 8], code: 'try … catch', branches: [{ key: 'try', label: '例外なし', nodes: [returned('s1b0', 'return x')] }, { key: 'catch', label: '例外が起きたとき', nodes: [answer] }] }] };
    const build = (toggled: string[]) => traceRows({ ...options, rootId: 'guarded', trees: new Map([...trees, ['guarded', guarded]]), state: EMPTY_TRACE, toggled: new Set(toggled) });
    const folded = build([]).find((row) => row.key === '|s1|catch') as Extract<Row, { kind: 'branch' }>;
    expect([folded.exit?.nodes.map((node) => node.id), folded.step]).toEqual([['s1h0'], 's1h0']);
    expect(build(['|s1h0']).map((row) => [row.key, row.kind === 'branch' ? row.exit : undefined])).toEqual([
      ['|s0', undefined],
      ['|s1', undefined],
      ['|s1b0', undefined],
      ['|s1|catch', undefined],
      ['|s1h0', undefined],
      ['|s1h0s0', undefined],
      ['|s1h0s1', undefined],
    ]);
  });

  it('should head the root with its start when the pull request changed its declaration', () => {
    const changed = { marks: { '': 'modified' }, removed: [], exprs: {}, hunks: { '': [{ base: 1, head: 1, lines: ['-a', '+b'] }] }, summary: [] } as unknown as FrameChange;
    const lines = traceRows({ ...options, state: EMPTY_TRACE, changes: new Map([['endpoint:token', changed]]) });
    expect(lines[0]).toEqual({ kind: 'start', key: '|start', frame: '', depth: 0, holds: [''], calls: [] });
  });

  it('should know the frames the outline shows in the order they run, and fall back to the nearest one it shows', () => {
    const order = frameOrder(traceRows({ ...options, state: { ...EMPTY_TRACE, open: ['s0b1n0', 's0b1n0.s0'] } }));
    expect([...order.keys()]).toEqual(['', 's0b1n0', 's0b1n0.s0']);
    expect([shownFrame('s0b1n0.s0', order), shownFrame('s0b1n0.s9', order), shownFrame('s7.s1', order)]).toEqual(['s0b1n0.s0', 's0b1n0', '']);
  });
});
