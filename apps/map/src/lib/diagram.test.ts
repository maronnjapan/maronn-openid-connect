import { describe, expect, it } from 'vitest';
import type { FlowTree, TreeNode } from '../types';
import { activeOf, frameDiagram } from './diagram';

const call = (id: string, callee: string): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: callee } });

/** Two actions, a fork, a try whose catch rethrows, a return. */
const tree: FlowTree = {
  id: 'core:f.ts#f',
  name: 'f',
  signature: 'f(x)',
  file: 'core:f.ts',
  lines: [1, 14],
  head: [1, 1],
  nodes: [
    { id: 's0', kind: 'action', lines: [2, 2], code: 'const a = 1' },
    { id: 's1', kind: 'action', lines: [3, 3], code: 'const b = 2' },
    { id: 's2', kind: 'if', lines: [4, 6], code: 'if (a)', subject: 'a', form: 'fork', branches: [{ key: 'true', label: '成立', nodes: [call('s2t0', 'g')] }, { key: 'false', label: '不成立', nodes: [] }] },
    {
      id: 's3',
      kind: 'try',
      lines: [7, 12],
      code: 'try … catch',
      subject: '例外',
      branches: [
        { key: 'try', label: '例外なし', nodes: [call('s3b0', 'h')] },
        { key: 'catch', label: '例外が起きたとき', nodes: [{ id: 's3h0', kind: 'throw', lines: [10, 10], code: 'throw error', error: 'error', rethrow: true }] },
      ],
    },
    { id: 's4', kind: 'return', lines: [13, 13], code: 'return b' },
  ],
};

describe('frameDiagram', () => {
  const diagram = frameDiagram(tree, '');
  const edge = (index: number) => diagram.edges[index];

  it('should draw a box for a node, one box for a run of actions, and arrows from each side of a decision', () => {
    expect(diagram.nodes.map((node) => [node.id, node.title, node.tone])).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', '処理 ×2', 'normal'],
      ['n:s2', 'if (a)', 'normal'],
      ['n:s2t0', 'g()', 'normal'],
      ['n:s3', 'try', 'normal'],
      ['n:s3b0', 'h()', 'normal'],
      ['n:s3h0', 'throw error', 'error'],
      ['n:s4', 'return b', 'end'],
    ]);
    expect(diagram.edges.map((arrow) => `${arrow.from}→${arrow.to}${arrow.label === undefined ? '' : ` ${arrow.label}`} (${arrow.kind})`)).toEqual([
      'start→n:s0 (flow)',
      'n:s0→n:s2 (flow)',
      'n:s2→n:s2t0 成立 (branch)',
      'n:s2t0→n:s3 (flow)',
      'n:s2→n:s3 不成立 (branch)',
      'n:s3→n:s3b0 (flow)',
      'n:s3→n:s3h0 例外が起きたとき (error)',
      'n:s3b0→n:s4 (flow)',
    ]);
    expect(diagram.nodes.find((node) => node.id === 'n:s2t0')?.target).toEqual({ fn: 'g' });
    expect(diagram.sides.get(4)).toEqual({ node: 's2', side: 'false' });
    expect(edge(6)?.kind).toBe('error');
  });

  it('should key a diagram by its frame, so a view of another frame starts afresh', () => {
    expect(diagram.key).toBe('frame:core:f.ts#f:');
    expect(frameDiagram(tree, 's1n0').key).toBe('frame:core:f.ts#f:s1n0');
  });

  it('should take the boxes and arrows a choice runs through, leaving out the arrows of the sides it does not take', () => {
    const active = activeOf(diagram, tree, '', [{ s2: 'false', s3: 'try' }]);
    expect([...active.nodes].sort()).toEqual(['n:s0', 'n:s2', 'n:s3', 'n:s3b0', 'n:s4', 'start']);
    expect([...active.edges].map((index) => `${edge(index)?.from}→${edge(index)?.to}`)).toEqual(['start→n:s0', 'n:s0→n:s2', 'n:s2→n:s3', 'n:s3→n:s3b0', 'n:s3b0→n:s4']);
  });

  it('should take everything when nothing is chosen', () => {
    const active = activeOf(diagram, tree, '', []);
    expect(active.nodes.size).toBe(diagram.nodes.length);
    expect(active.edges.size).toBe(diagram.edges.length);
  });
});
