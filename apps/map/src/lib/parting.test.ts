import { describe, expect, it } from 'vitest';
import type { Parting } from '@maronn-openid-connect/map-analysis/traced';
import { FAILS, SKIPS } from '@maronn-openid-connect/map-analysis/walk';
import type { Branch, FlowTree, MapData, TreeNode } from '../types';
import { partingLines, partingWords } from './parting';
import { scenesOf, walkTrace } from './playback';

/** A tree of nodes written by hand. */
function tree(id: string, nodes: TreeNode[]): FlowTree {
  return { id, name: id, signature: `${id}()`, file: 'x', lines: [1, 20], head: [1, 1], nodes };
}
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee }, ...extra });
const returned = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'return', lines: [4, 4], code: 'return x', ...extra });
const side = (key: string, label: string, nodes: TreeNode[]): Branch => ({ key, label, nodes });

// An endpoint that describes a token: active when it was found, inactive otherwise.
const DESCRIBE = 'hono:describe.ts#describe';
const describeTree = tree(DESCRIBE, [
  { id: 's0', kind: 'if', lines: [2, 2], code: 'if (resolved !== null)', text: 'トークンが見つかったか', from: 'comment', form: 'guard', branches: [side('true', '成立', [returned('s0t0')]), side('false', '不成立', [])] },
  returned('s1'),
]);
const root = tree('endpoint:introspection', [call('s0', DESCRIBE), call('s1', 'hono:respond.ts#respond'), returned('s2')]);
const trees = new Map([
  [root.id, root],
  [DESCRIBE, describeTree],
]);
const data = {
  functions: { [DESCRIBE]: { id: DESCRIBE, name: 'describe' } },
  bodies: { [root.id]: { id: root.id, name: 'POST /introspect', endpoint: 'introspection' } },
  members: {},
} as unknown as Pick<MapData, 'functions' | 'bodies' | 'members'>;

/** The scenes of the root walked on a choice with some frames open, a node a scene. */
function scenes(choice: Record<string, string>, open: string[]) {
  return scenesOf(walkTrace(root, choice, { open, trees }), (stop) => `n:${stop.node.id}`);
}

describe('partingLines', () => {
  const inDescribe: Parting = { frame: 's0', tree: DESCRIBE, at: { node: 's0', side: 'false', other: 'true' } };

  it('should say the function, the decision, the side taken and the side the request before the edits took, with the scene that shows the decision', () => {
    const played = scenes({ 's0.s0': 'false' }, ['s0']);

    expect(partingLines([inDescribe], played, trees, data)).toEqual([{ frame: 's0', node: 's0', name: 'describe()', text: 'トークンが見つかったか', code: false, side: '不成立', other: '成立', scene: 1 }]);
    expect(played[1]?.frame).toBe('s0');
  });

  it('should give no scene while the playback does not go into the frame', () => {
    expect(partingLines([inDescribe], scenes({}, []), trees, data).map(({ name, scene }) => ({ name, scene }))).toEqual([{ name: 'describe()', scene: undefined }]);
  });

  it('should name the endpoint for its root, and say of a call whether it fails or is not evaluated in each request', () => {
    const fails: Parting = { frame: '', tree: root.id, at: { node: 's1', side: FAILS } };
    const skipped: Parting = { frame: '', tree: root.id, at: { node: 's1', other: SKIPS } };
    const said = partingLines([fails, skipped], scenes({ s1: FAILS }, []), trees, data);

    expect(said.map(({ name, text, code, side: taken, other }) => ({ name, text, code, taken, other }))).toEqual([
      { name: 'POST /introspect', text: 'hono:respond.ts#respond()', code: true, taken: '失敗する', other: '失敗しない' },
      { name: 'POST /introspect', text: 'hono:respond.ts#respond()', code: true, taken: '評価する', other: '評価しない' },
    ]);
  });

  it('should leave out a parting whose tree is not loaded or whose node the tree does not have', () => {
    const elsewhere: Parting = { frame: 's9', tree: 'hono:gone.ts#gone', at: { node: 's0' } };
    const noNode: Parting = { frame: 's0', tree: DESCRIBE, at: { node: 's7' } };

    expect(partingLines([elsewhere, noNode], scenes({}, []), trees, data)).toEqual([]);
  });
});

describe('partingWords', () => {
  it('should say how many places the way parts at, or that the edited request takes the same way', () => {
    expect(partingWords(2)).toContain('次の 2 か所で道筋が分かれます');
    expect(partingWords(0)).toContain('書き換える前のリクエストと同じ道筋を通ります');
  });
});
