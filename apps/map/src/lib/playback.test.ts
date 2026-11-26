import { describe, expect, it } from 'vitest';
import type { Branch, FlowTree, Selection, TreeNode } from '../types';
import { callsToEnter, departureScene, depthOf, sceneAt, sceneDuration, sceneLines, scenarioOf, scenesOf, selectionKey, SPEEDS, stopKey, walkTrace, withoutDeepest } from './playback';
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

  it('should go to the call that opened the frame it was in, when that frame is no longer gone into', () => {
    const closed = scenesOf(walkTrace(root, {}, { open: [], trees }), shapeOf);

    // The playback was inside verify(), and a frame below it: the scene of the call of verify() in the root.
    expect(sceneAt(closed, { frame: 's0b0s0', node: 's1' }, 3)).toBe(0);
    expect(sceneAt(closed, { frame: 's0b0s0.s5', node: 's2' }, 3)).toBe(0);
    expect(closed[0]?.stops.map((stop) => stop.node.id)).toContain('s0b0s0');
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

describe('departureScene', () => {
  const scenesFor = (choice: Record<string, string>, open: string[]) => scenesOf(walkTrace(root, choice, { open, trees }), shapeOf);
  const stopsFor = (choice: Record<string, string>, open: string[]) => walkTrace(root, choice, { open, trees }).stops;

  it('should find the decision both ways reach that the new way takes on the other side', () => {
    // verify() fails now where it went on before: the guard that takes the other side, before the throw after it.
    expect(departureScene(stopsFor({}, ['s0b0s0']), scenesFor({ 's0b0s0.s0': 'true' }, ['s0b0s0']))).toBe(1);
    // And back: the guard that no longer fails.
    expect(departureScene(stopsFor({ 's0b0s0.s0': 'true' }, ['s0b0s0']), scenesFor({}, ['s0b0s0']))).toBe(1);
  });

  it('should find the failure the way before did not have, when it went past the call without going into it', () => {
    expect(departureScene(stopsFor({}, []), scenesFor({ 's0b0s0.s0': 'true' }, ['s0b0s0']))).toBe(2);
  });

  it('should find nothing for the same way, for a failure at the same place, and for a frame only one of them goes into', () => {
    expect(departureScene(stopsFor({}, []), scenesFor({}, []))).toBeUndefined();
    expect(departureScene(stopsFor({ 's0b0s0.s0': 'true' }, ['s0b0s0']), scenesFor({ 's0b0s0.s0': 'true' }, ['s0b0s0']))).toBeUndefined();
    expect(departureScene(stopsFor({}, []), scenesFor({}, ['s0b0s0']))).toBeUndefined();
    // The way before failed inside verify(); the new one steps over it and does not fail: nothing to tell apart in the frames both show.
    expect(departureScene(stopsFor({ 's0b0s0.s0': 'true' }, ['s0b0s0']), scenesFor({}, []))).toBeUndefined();
  });

  it('should find nothing in no scenes', () => {
    expect(departureScene(stopsFor({}, []), [])).toBeUndefined();
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

  it('should keep the chosen path when another path has the same decisions', () => {
    const path: Selection = { kind: 'step', name: 'another step', decisions: { s0: 'catch' }, target: 's0h1' };
    const withDuplicate = [...selections, path];

    expect(scenarioOf(withDuplicate, path.decisions, selectionKey(path))).toBe(2);
    expect(scenarioOf(withDuplicate, path.decisions)).toBe(-1);
    expect(scenarioOf(withDuplicate, { s0: 'try' }, selectionKey(path))).toBe(-1);
  });

  it('should restore an explicitly chosen path without decisions', () => {
    const path: Selection = { kind: 'exit', name: 'return', decisions: {}, target: 's0' };
    expect(scenarioOf([path], undefined, selectionKey(path))).toBe(0);
    expect(scenarioOf([path], undefined)).toBe(-1);
  });
});

describe('sceneDuration', () => {
  it('should stay 2.6 s on a scene at the normal pace, shorter at a higher speed, and never stop', () => {
    expect(SPEEDS).toEqual([0.5, 1, 2, 4]);
    expect(SPEEDS.map((speed) => sceneDuration(speed))).toEqual([5200, 2600, 1300, 650]);
    expect(sceneDuration(0)).toBe(10400);
  });
});
