import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, TreeNode } from '../model.js';
import { assumedSide, FAILS, SKIPS, stepsOf, walkFlow, type WalkStop } from '../walk.js';

/** A tree of nodes written by hand. */
function tree(id: string, nodes: TreeNode[]): FlowTree {
  return { id, name: id, signature: `${id}()`, file: 'x', lines: [1, 20], head: [1, 1], nodes };
}
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee }, ...extra });
const action = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'action', lines: [2, 2], code: `${id} = 1`, ...extra });
const thrown = (id: string, error: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'throw', lines: [3, 3], code: `throw ${error}`, error, ...extra });
const returned = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'return', lines: [4, 4], code: 'return x', ...extra });
const side = (key: string, label: string, nodes: TreeNode[], extra: Partial<Branch> = {}): Branch => ({ key, label, nodes, ...extra });
const guard = (id: string, yes: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'if', lines: [2, 3], code: `if (${id})`, form: 'guard', branches: [side('true', '成立', yes), side('false', '不成立', [])], ...extra });
const fork = (id: string, yes: TreeNode[], no: TreeNode[]): TreeNode => ({ id, kind: 'if', lines: [2, 5], code: `if (${id})`, form: 'fork', branches: [side('true', '成立', yes), side('false', '不成立', no)] });
const attempt = (id: string, body: TreeNode[], handler?: TreeNode[], final?: TreeNode[]): TreeNode => ({
  id,
  kind: 'try',
  lines: [2, 9],
  code: 'try … catch',
  branches: [side('try', '例外なし', body), ...(handler === undefined ? [] : [side('catch', '例外が起きたとき', handler)]), ...(final === undefined ? [] : [side('finally', '最後に必ず', final, { always: true })])],
});
const step = (id: string, name: string, body: TreeNode[], extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'block', lines: [2, 4], code: `[${name}]`, step: { id: name, label: name }, branches: [side('body', name, body)], ...extra });

/** A stop as the tests read it: `<frame>|<node>` with its event, its side and its error. */
function said(stop: WalkStop): string {
  const where = stop.frame === '' ? stop.node.id : `${stop.frame}|${stop.node.id}`;
  const taken = stop.side === undefined ? '' : `:${stop.side.key}${stop.side.assumed ? '?' : ''}`;
  return `${where}${taken}${stop.event === undefined ? '' : ` ${stop.event}`}${stop.error === undefined ? '' : ` ${stop.error}`}`;
}

describe('walkFlow', () => {
  it('should run the nodes in order, the calls evaluated before a node first, and end at a return', () => {
    const root = tree('root', [action('s0'), returned('s1', { pre: [call('s1i0', 'respond')] }), action('s2')]);
    const walked = walkFlow(root, {});
    expect(walked.stops.map(said)).toEqual(['s0', 's1i0', 's1 returns']);
    expect(walked.outcome).toBe('returns');
    expect(walked.resolved).toEqual({});
  });

  it('should pass a guard the choice does not decide, and say that it assumed that side', () => {
    const root = tree('root', [guard('s0', [thrown('s0t0', 'TokenError(invalid_client)')]), returned('s1')]);
    const walked = walkFlow(root, {});
    expect(walked.stops.map(said)).toEqual(['s0:false?', 's1 returns']);
    expect(walked.resolved).toEqual({ s0: 'false' });
    expect(walked.assumed).toEqual(['s0']);
  });

  it('should take the side the choice names, and leave the frame with the failure of a throw', () => {
    const root = tree('root', [guard('s0', [thrown('s0t0', 'TokenError(invalid_client)')]), returned('s1')]);
    const walked = walkFlow(root, { s0: 'true' });
    expect(walked.stops.map(said)).toEqual(['s0:true', 's0t0 throws TokenError(invalid_client)']);
    expect(walked.outcome).toBe('fails');
    expect(walked.error).toBe('TokenError(invalid_client)');
    expect(walked.assumed).toEqual([]);
  });

  it('should take the first side of a fork that the choice does not decide', () => {
    const root = tree('root', [fork('s0', [action('s0t0')], [action('s0f0')]), returned('s1')]);
    expect(walkFlow(root, {}).stops.map(said)).toEqual(['s0:true?', 's0t0', 's1 returns']);
    expect(walkFlow(root, { s0: 'false' }).stops.map(said)).toEqual(['s0:false', 's0f0', 's1 returns']);
  });

  it('should run the catch of the try around a call the choice makes fail, and go on after the try', () => {
    const root = tree('root', [attempt('s0', [call('s0b0', 'verify'), action('s0b1')], [action('s0h0')]), returned('s1')]);
    const walked = walkFlow(root, { s0b0: FAILS });
    expect(walked.stops.map(said)).toEqual(['s0b0 fails', 's0:catch catches', 's0h0', 's1 returns']);
    expect(walked.outcome).toBe('returns');
    // The try keeps no side: its body ran up to the failure and its catch ran.
    expect(walked.resolved).toEqual({ s0b0: FAILS });
  });

  it('should say that a try runs without an exception when nothing in it fails', () => {
    const root = tree('root', [attempt('s0', [action('s0b0')], [returned('s0h0')]), returned('s1')]);
    const walked = walkFlow(root, {});
    expect(walked.stops.map(said)).toEqual(['s0b0', 's1 returns']);
    expect(walked.resolved).toEqual({ s0: 'try' });
    expect(walked.assumed).toEqual(['s0']);
  });

  it('should skip the body of a try whose catch the choice takes with no failure in sight', () => {
    const root = tree('root', [attempt('s0', [action('s0b0')], [returned('s0h0')])]);
    const walked = walkFlow(root, { s0: 'catch' });
    expect(walked.stops.map(said)).toEqual(['s0:catch catches', 's0h0 returns']);
    expect(walked.resolved).toEqual({ s0: 'catch' });
  });

  it('should run a finally whichever way its try came out, and let the failure go on after it', () => {
    const root = tree('root', [attempt('s0', [thrown('s0b0', 'Error')], undefined, [action('s0f0')]), returned('s1')]);
    const walked = walkFlow(root, {});
    expect(walked.stops.map(said)).toEqual(['s0b0 throws Error', 's0f0']);
    expect(walked.outcome).toBe('fails');
    expect(walked.error).toBe('Error');
  });

  it('should go into the frame of a call it is told to enter, and come back to the caller', () => {
    const inner = tree('verify', [guard('s0', [thrown('s0t0', 'TokenError(invalid_client)')]), returned('s1')]);
    const root = tree('root', [call('s0', 'verify'), returned('s1')]);
    const walked = walkFlow(root, {}, { enter: (key) => (key === 's0' ? inner : undefined) });
    expect(walked.stops.map(said)).toEqual(['s0 enters', 's0|s0:false?', 's0|s1 returns', 's1 returns']);
    expect(walked.stops.map((stop) => stop.depth)).toEqual([0, 1, 1, 0]);
    expect(walked.stops.map((stop) => stop.tree)).toEqual(['root', 'verify', 'verify', 'root']);
    expect(walked.resolved).toEqual({ 's0.s0': 'false' });
  });

  it('should bring the failure of an entered frame up to the catch of its caller, with what was thrown', () => {
    const inner = tree('verify', [guard('s0', [thrown('s0t0', 'TokenError(invalid_client)')]), returned('s1')]);
    const root = tree('root', [attempt('s0', [call('s0b0', 'verify')], [returned('s0h0')])]);
    const walked = walkFlow(root, { 's0b0.s0': 'true' }, { enter: () => inner });
    expect(walked.stops.map(said)).toEqual(['s0b0 enters', 's0b0|s0:true', 's0b0|s0t0 throws TokenError(invalid_client)', 's0:catch catches TokenError(invalid_client)', 's0h0 returns']);
    // The call failed, whether the choice said so or not: the walk is what runs.
    expect(walked.resolved).toEqual({ 's0b0.s0': 'true', s0b0: FAILS });
    expect(walked.outcome).toBe('returns');
  });

  it('should fail at a call the choice makes fail when the way through its frame does not throw', () => {
    const inner = tree('verify', [returned('s0')]);
    const root = tree('root', [call('s0', 'verify'), returned('s1')]);
    const walked = walkFlow(root, { s0: FAILS }, { enter: () => inner });
    expect(walked.stops.map(said)).toEqual(['s0 enters', 's0|s0 returns', 's0 fails']);
    expect(walked.outcome).toBe('fails');
    expect(walked.error).toBeUndefined();
  });

  it('should not enter a frame that is already on the way down', () => {
    const root = tree('root', [guard('s0', [returned('s0t0')]), call('s1', 'root'), returned('s2')]);
    const walked = walkFlow(root, {}, { enter: () => root });
    expect(walked.stops.map(said)).toEqual(['s0:false?', 's1', 's2 returns']);
  });

  it('should leave out the nodes of a feature that is off, and keep the one side of a decision that reads its value', () => {
    const root = tree('root', [
      step('s0', 'refresh', [call('s0s0', 'validateRefresh')], { feature: 'refresh-token' }),
      { id: 's1', kind: 'cond-expr', lines: [5, 5], code: 'a ?? f()', operator: '??', absent: { feature: 'refresh-token', side: 'nullish' }, branches: [side('defined', '値あり', []), side('nullish', 'null または undefined', [call('s1n0', 'validateCode')])] },
      returned('s2'),
    ]);
    const on = walkFlow(root, {}, { enabled: new Set(['refresh-token']) });
    expect(on.stops.map(said)).toEqual(['s0', 's0s0', 's1:defined?', 's2 returns']);
    const off = walkFlow(root, {}, { enabled: new Set() });
    expect(off.stops.map(said)).toEqual(['s1:nullish', 's1n0', 's2 returns']);
    // A side a feature forces is no choice: it is not among the sides resolved.
    expect(off.resolved).toEqual({});
  });

  it('should run a loop once, or not at all when the choice skips it, and a case that falls through into the next', () => {
    const loop: TreeNode = { id: 's0', kind: 'loop', lines: [2, 4], code: 'for (const x of xs)', branches: [side('body', '繰り返す', [action('s0b0')]), side('skip', '繰り返さない', [])] };
    const cases: TreeNode = { id: 's1', kind: 'switch', lines: [5, 9], code: 'switch (kind)', branches: [side('c0', "case 'a'", [action('s1c0s0')], { fallsThrough: true }), side('c1', "case 'b'", [action('s1c1s0')]), side('default', 'default', [action('s1ds0')])] };
    const root = tree('root', [loop, cases]);
    expect(walkFlow(root, {}).stops.map(said)).toEqual(['s0:body?', 's0b0', 's1:c0?', 's1c0s0', 's1c1s0']);
    expect(walkFlow(root, { s0: 'skip', s1: 'default' }).stops.map(said)).toEqual(['s0:skip', 's1:default', 's1ds0']);
  });

  it('should pass a call the choice says is not evaluated, and its arguments, without a stop', () => {
    const root = tree('root', [guard('s0', [returned('s0t0')], { pre: [call('s0i0', 'check', { pre: [call('s0i0i0', 'read')] })] }), returned('s1')]);
    const walked = walkFlow(root, { s0i0: SKIPS, s0: 'false' }, { enter: () => tree('check', [returned('s0')]) });
    expect(walked.stops.map(said)).toEqual(['s0:false', 's1 returns']);
  });

  it('should fail at a statement the choice makes fail, what it calls outside the map throwing', () => {
    const root = tree('root', [attempt('s0', [action('s0b0'), action('s0b1')], [action('s0h0')]), returned('s1')]);
    const walked = walkFlow(root, { s0b0: FAILS });
    expect(walked.stops.map(said)).toEqual(['s0b0 fails', 's0:catch catches', 's0h0', 's1 returns']);
    expect(walked.resolved).toEqual({ s0b0: FAILS });
  });

  it('should go on past a return inside a callback, which ends no frame', () => {
    const root = tree('root', [returned('s0', { local: true }), returned('s1')]);
    expect(walkFlow(root, {}).stops.map(said)).toEqual(['s0', 's1 returns']);
  });

  it('should stop at its limit and say so', () => {
    const root = tree('root', [action('s0'), action('s1'), action('s2')]);
    const walked = walkFlow(root, {}, { limit: 2 });
    expect(walked.stops).toHaveLength(2);
    expect(walked.cut).toBe(true);
  });
});

describe('stepsOf', () => {
  it('should list the steps of the starting frame the walk runs, each once, up to where it ends', () => {
    const root = tree('root', [
      attempt(
        's0',
        [step('s0b0', 'parse', [call('s0b0s0', 'parse', { step: { id: 'parse', label: 'parse' } })]), step('s0b1', 'authenticate', [call('s0b1s0', 'authenticate')]), step('s0b2', 'issue', [call('s0b2s0', 'issue')])],
        [returned('s0h0', { pre: [call('s0h0i0', 'respondError', { step: { id: 'respond-error', label: 'respond-error' } })] })],
      ),
    ]);
    expect(stepsOf(walkFlow(root, {}))).toEqual(['parse', 'authenticate', 'issue']);
    expect(stepsOf(walkFlow(root, { s0b1s0: FAILS }))).toEqual(['parse', 'authenticate', 'respond-error']);
  });

  it('should leave out the steps of the frames the walk enters', () => {
    const inner = tree('parse', [step('s0', 'inner-step', [action('s0s0')])]);
    const root = tree('root', [step('s0', 'parse', [call('s0s0', 'parse')])]);
    expect(stepsOf(walkFlow(root, {}, { enter: () => inner }))).toEqual(['parse']);
  });
});

describe('assumedSide', () => {
  it('should take the side that goes on at a guard, the body of a try and of a loop, and the first side when every side ends', () => {
    const passes = guard('s0', [returned('s0t0')]);
    expect(assumedSide(passes, passes.branches ?? [])?.key).toBe('false');
    const tried = attempt('s1', [returned('s1b0')], [action('s1h0')]);
    expect(assumedSide(tried, tried.branches ?? [])?.key).toBe('try');
    const both = fork('s2', [returned('s2t0')], [thrown('s2f0', 'Error')]);
    expect(assumedSide(both, both.branches ?? [])?.key).toBe('true');
  });
});
