import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, Selection, TreeNode } from '../types';
import { callsToEnter, depthOf, returnedValue, sceneAt, sceneDuration, sceneGist, sceneLines, scenarioOf, scenesOf, stopKey, walkTrace, wayEnding, withoutDeepest } from './playback';
import { nodesRun } from './trace';

/** A tree of nodes written by hand. */
function tree(id: string, nodes: TreeNode[]): FlowTree {
  return { id, name: id, signature: `${id}()`, file: 'x', lines: [1, 20], head: [1, 1], nodes };
}
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee }, ...extra });
const thrown = (id: string, error: string): TreeNode => ({ id, kind: 'throw', lines: [3, 3], code: `throw ${error}`, error });
const returned = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'return', lines: [4, 4], code: 'return x', ...extra });
const side = (key: string, label: string, nodes: TreeNode[]): Branch => ({ key, label, nodes });
const guard = (id: string, yes: TreeNode[]): TreeNode => ({ id, kind: 'if', lines: [2, 3], code: `if (${id})`, text: `${id} か`, from: 'doc', form: 'guard', branches: [side('true', '成立', yes), side('false', '不成立', [])] });
const step = (id: string, name: string, body: TreeNode[]): TreeNode => ({ id, kind: 'block', lines: [2, 4], code: `[${name}]`, step: { id: name, label: name }, branches: [side('body', name, body)] });

const verify = tree('verify', [guard('s0', [thrown('s0t0', 'TokenError(invalid_client)')]), returned('s1')]);
const root = tree('root', [
  {
    id: 's0',
    kind: 'try',
    lines: [2, 12],
    code: 'try … catch',
    branches: [side('try', '例外なし', [step('s0b0', 'authenticate', [call('s0b0s0', 'verify')]), step('s0b1', 'respond', [returned('s0b1s0')])]), side('catch', '例外が起きたとき', [returned('s0h0', { pre: [call('s0h0i0', 'respondError')] })])],
  },
]);
const trees = new Map([
  ['root', root],
  ['verify', verify],
]);
const words = { functions: {}, members: {} };

/** A diagram that draws a step as one box and the catch as a row of the region of its try, as the page does. */
function shapeOf(stop: { frame: string; node: TreeNode }): string | undefined {
  if (stop.frame !== '') return `n:${stop.node.id}`;
  if (stop.node.id === 's0' || stop.node.id.startsWith('s0h')) return 'g:s0';
  return `n:${stop.node.id.slice(0, 4)}`;
}

describe('walkTrace', () => {
  it('should go into the frames the trace has open, and only into those', () => {
    expect(walkTrace(root, {}, { open: [], trees }).stops.map(stopKey)).toEqual(['s0b0', 's0b0s0', 's0b1', 's0b1s0']);
    expect(walkTrace(root, {}, { open: ['s0b0s0'], trees }).stops.map(stopKey)).toEqual(['s0b0', 's0b0s0', 's0b0s0.s0', 's0b0s0.s1', 's0b1', 's0b1s0']);
  });

  it('should step over a call whose tree has not loaded yet', () => {
    expect(walkTrace(root, {}, { open: ['s0b0s0'], trees: new Map([['root', root]]) }).stops.map(stopKey)).toEqual(['s0b0', 's0b0s0', 's0b1', 's0b1s0']);
  });

  it('should take only nodes the outline runs for the sides the walk resolved', () => {
    const walked = walkTrace(root, { 's0b0s0.s0': 'true' }, { open: ['s0b0s0'], trees });
    const ran = new Map([
      ['', nodesRun(root, '', [walked.resolved], undefined)],
      ['s0b0s0', nodesRun(verify, 's0b0s0', [walked.resolved], undefined)],
    ]);
    expect(walked.stops.filter((stop) => ran.get(stop.frame)?.has(stop.node.id) !== true).map(stopKey)).toEqual([]);
  });
});

describe('scenesOf', () => {
  it('should read the stops one box shows in a row as one scene', () => {
    const scenes = scenesOf(walkTrace(root, {}, { open: [], trees }), shapeOf);
    expect(scenes.map((scene) => [scene.shape, scene.stops.map((stop) => stop.node.id), scene.tone])).toEqual([
      ['n:s0b0', ['s0b0', 's0b0s0'], 'normal'],
      ['n:s0b1', ['s0b1', 's0b1s0'], 'end'],
    ]);
    expect(scenes.map((scene) => scene.index)).toEqual([0, 1]);
    expect(scenes.map((scene) => scene.step)).toEqual(['authenticate', 'respond']);
  });

  it('should come back to a box as a new scene after the frame of its call, and read a failure and its catch by their tone', () => {
    const scenes = scenesOf(walkTrace(root, { 's0b0s0.s0': 'true' }, { open: ['s0b0s0'], trees }), shapeOf);
    expect(scenes.map((scene) => [scene.frame, scene.shape, scene.tone, scene.depth])).toEqual([
      ['', 'n:s0b0', 'normal', 0],
      ['s0b0s0', 'n:s0', 'normal', 1],
      ['s0b0s0', 'n:s0t0', 'error', 1],
      ['', 'g:s0', 'caught', 0],
    ]);
  });

  it('should make a scene of its own of a stop no shape shows', () => {
    const scenes = scenesOf(walkTrace(root, {}, { open: [], trees }), () => undefined);
    expect(scenes).toHaveLength(4);
  });
});

describe('sceneAt', () => {
  const scenes = scenesOf(walkTrace(root, {}, { open: ['s0b0s0'], trees }), shapeOf);

  it('should stay on the scene that holds the node the playback was at', () => {
    expect(sceneAt(scenes, { frame: 's0b0s0', node: 's1' }, 0)).toBe(2);
    expect(sceneAt(scenes, { frame: '', node: 's0b1s0' }, 0)).toBe(3);
  });

  it('should keep the place, inside the list, when the node is gone', () => {
    expect(sceneAt(scenes, { frame: 'gone', node: 's9' }, 2)).toBe(2);
    expect(sceneAt(scenes, undefined, 99)).toBe(scenes.length - 1);
    expect(sceneAt([], undefined, 3)).toBe(0);
  });
});

describe('sceneLines', () => {
  it('should say the side a decision takes with the sides to take, and leave out the heading of a step', () => {
    const scenes = scenesOf(walkTrace(root, {}, { open: ['s0b0s0'], trees }), shapeOf);
    expect(sceneLines(scenes[0] as (typeof scenes)[number], words).map((line) => [line.kind, line.text])).toEqual([['enters', 'verify()']]);
    const decided = sceneLines(scenes[1] as (typeof scenes)[number], words);
    expect(decided.map((line) => [line.kind, line.text, line.decision])).toEqual([['side', 's0 か', { key: 's0b0s0.s0', taken: 'false', assumed: true, sides: [{ key: 'true', label: '成立' }, { key: 'false', label: '不成立' }] }]]);
  });

  it('should say what fails and that the catch takes it', () => {
    const scenes = scenesOf(walkTrace(root, { 's0b0s0.s0': 'true' }, { open: ['s0b0s0'], trees }), shapeOf);
    expect(sceneLines(scenes[2] as (typeof scenes)[number], words).map((line) => [line.kind, line.error])).toEqual([['throws', 'TokenError(invalid_client)']]);
    expect(sceneLines(scenes[3] as (typeof scenes)[number], words).map((line) => [line.kind, line.error])).toEqual([
      ['catches', 'TokenError(invalid_client)'],
      ['does', undefined],
      ['returns', undefined],
    ]);
  });
});

describe('the frames a playback opens', () => {
  it('should list the calls stepped over that have a frame, by the key of that frame', () => {
    const walked = walkTrace(root, {}, { open: [], trees });
    expect(callsToEnter(walked, (id) => id === 'verify')).toEqual(['s0b0s0']);
    expect(callsToEnter(walked, () => false)).toEqual([]);
    expect(callsToEnter(walkTrace(root, {}, { open: ['s0b0s0'], trees }), (id) => id === 'verify')).toEqual([]);
  });

  it('should fold back the deepest frames only', () => {
    expect(depthOf('')).toBe(0);
    expect(depthOf('s0b0s0.s1')).toBe(2);
    expect(withoutDeepest(['s0', 's0.s1', 's2', 's0.s1.s3'])).toEqual(['s0', 's0.s1', 's2']);
    expect(withoutDeepest(['s0', 's2'])).toEqual([]);
    expect(withoutDeepest([])).toEqual([]);
  });
});

describe('scenarioOf', () => {
  const selections: Selection[] = [
    { kind: 'step', name: 'a', decisions: { s0: 'try', s1: 'true' }, target: 's1' },
    { kind: 'exit', name: 'b', decisions: { s0: 'catch' }, target: 's0h0' },
  ];

  it('should find the ready-made choice whose sides are exactly those chosen', () => {
    expect(scenarioOf(selections, { s1: 'true', s0: 'try' })).toBe(0);
    expect(scenarioOf(selections, { s0: 'catch' })).toBe(1);
  });

  it('should find none for no choice or another one', () => {
    expect(scenarioOf(selections, undefined)).toBe(-1);
    expect(scenarioOf(selections, { s0: 'try' })).toBe(-1);
  });
});

describe('sceneDuration', () => {
  it('should stay shorter on a scene at a higher speed, and never stop', () => {
    expect(sceneDuration(1)).toBe(1500);
    expect(sceneDuration(2)).toBe(750);
    expect(sceneDuration(0)).toBe(6000);
  });
});

describe('sceneGist', () => {
  it('should say the kind of the step a scene is the box of, what it hands on, and how it ends', () => {
    const scenes = scenesOf(walkTrace(root, {}, { open: [], trees }), shapeOf);
    expect(sceneGist(scenes[0] as (typeof scenes)[number], { kind: 'validate', produces: ['client'] })).toEqual({ kind: '検証', hands: ['client'], sides: [], enters: false });
    expect(sceneGist(scenes[1] as (typeof scenes)[number])).toEqual({ sides: [], enters: false, end: { tone: 'end', text: '`x` を返して終わる' } });
  });

  it('should say that a scene goes into a call, the side a decision takes, a failure and the catch that takes it', () => {
    const scenes = scenesOf(walkTrace(root, { 's0b0s0.s0': 'true' }, { open: ['s0b0s0'], trees }), shapeOf);
    expect(scenes.map((scene) => sceneGist(scene))).toEqual([
      { sides: [], enters: true },
      { sides: [{ label: '成立', assumed: false }], enters: false },
      { sides: [], enters: false, end: { tone: 'error', text: '失敗 `TokenError(invalid_client)`' } },
      { sides: [], enters: false, end: { tone: 'caught', text: '例外 `TokenError(invalid_client)` を受け取る、`x` を返して終わる' } },
    ]);
  });

  it('should leave out the kind of a step for a scene inside it', () => {
    const scenes = scenesOf(walkTrace(root, {}, { open: [], trees }), (stop) => `n:${stop.node.id}`);
    expect(sceneGist(scenes[1] as (typeof scenes)[number], { kind: 'validate', produces: ['client'] }).kind).toBeUndefined();
  });
});

describe('wayEnding', () => {
  it('should say what the root returns, as code', () => {
    expect(wayEnding(walkTrace(root, {}, { open: [], trees }), true)).toEqual({ tone: 'end', text: '`x` を返して終わる' });
  });

  it('should say the failure its catch answered, as an answer of an endpoint or a return of a function', () => {
    const walked = walkTrace(root, { 's0b0s0.s0': 'true' }, { open: ['s0b0s0'], trees });
    expect(wayEnding(walked, true)).toEqual({ tone: 'caught', text: '失敗 `TokenError(invalid_client)` → `x` で応答して終わる' });
    expect(wayEnding(walked, false)).toEqual({ tone: 'caught', text: '失敗 `TokenError(invalid_client)` → `x` を返して終わる' });
  });

  it('should say the failure that leaves the root', () => {
    expect(wayEnding(walkTrace(verify, { s0: 'true' }, { open: [], trees }), false)).toEqual({ tone: 'error', text: '失敗 `TokenError(invalid_client)` が外へ出る' });
  });
});

describe('returnedValue', () => {
  it('should read the value of a return as code, and nothing for a return of nothing', () => {
    expect(returnedValue('return respondToken(c, x);')).toBe('respondToken(c, x)');
    expect(returnedValue('return  await  f(a,\n b)')).toBe('await f(a, b)');
    expect(returnedValue('return;')).toBe('');
  });
});
