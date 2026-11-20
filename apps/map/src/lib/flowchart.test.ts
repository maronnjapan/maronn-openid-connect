import { describe, expect, it } from 'vitest';
import type { FlowTree, TreeNode } from '../types';
import { boxOf, frameDiagram, type Diagram } from './diagram';
import { chartWay, decisionLines, DECISION_WIDTH, flowChart, layoutChart, stepDetail, stepValues, wayAt, type Chart, type ChartStep } from './flowchart';
import { scenesOf, walkTrace } from './playback';
import type { WordSource } from './words';

const fn = (name: string) => `core:f.ts#${name}`;
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}(c)`, target: { kind: 'function', id: fn(callee) }, ...extra });
const returned = (id: string, code: string): TreeNode => ({ id, kind: 'return', lines: [3, 3], code });
const thrown = (id: string, error: string): TreeNode => ({ id, kind: 'throw', lines: [3, 3], code: `throw new ${error}`, error });
const guard = (id: string, code: string, yes: TreeNode[]): TreeNode => ({ id, kind: 'if', lines: [4, 6], code, subject: code, form: 'guard', branches: [{ key: 'true', label: '成立', nodes: yes }, { key: 'false', label: '不成立', nodes: [] }] });
const step = (id: string, name: string, label: string, nodes: TreeNode[]): TreeNode => ({ id, kind: 'block', lines: [2, 9], code: `[${id}]`, text: label, step: { id: name, label }, branches: [{ key: 'body', label, nodes }] });
const words: WordSource = {
  functions: {
    [fn('verify')]: { summary: 'クライアントを確かめる。' } as WordSource['functions'][string],
    [fn('f')]: { summary: '関数 f の説明。続き。' } as WordSource['functions'][string],
  },
  members: {},
};

/** An endpoint: a try around four steps (read, check, a dispatch that may answer at once, answer), its catch answering the failure. */
const endpoint: FlowTree = {
  id: 'endpoint:token',
  name: 'POST /token',
  signature: 'POST /token',
  file: 'x',
  lines: [1, 40],
  head: [1, 1],
  nodes: [
    {
      id: 's0',
      kind: 'try',
      lines: [2, 30],
      code: 'try … catch',
      branches: [
        {
          key: 'try',
          label: '例外なし',
          nodes: [
            step('s0b0', 'parse', 'リクエストを読む', [call('s0b0s0', 'parse')]),
            step('s0b1', 'check', 'クライアントを確かめる', [guard('s0b1s0', 'if (!client)', [thrown('s0b1s0t0', 'TokenError(invalid_client)')])]),
            step('s0b2', 'dispatch', 'すぐ応答するか決める', [call('s0b2s0', 'early'), guard('s0b2s1', 'if (early)', [returned('s0b2s1t0', 'return early')])]),
            step('s0b3', 'respond', '応答する', [returned('s0b3s0', 'return respond(c, body)')]),
          ],
        },
        { key: 'catch', label: '例外が起きたとき', nodes: [returned('s0h0', 'return respondError(c, error)')] },
      ],
    },
  ],
};
const steps: ChartStep[] = [
  { id: 'parse', kind: 'parse', consumes: [], produces: ['params', 'authorization'] },
  { id: 'check', kind: 'validate', consumes: ['params', 'authorization'], produces: ['client', 'unused'] },
  { id: 'dispatch', kind: 'dispatch', consumes: ['params', 'client'], produces: [] },
  { id: 'respond', kind: 'respond', consumes: ['client'], produces: [] },
];

/** A function: a guard that fails, a call, and a return. */
const fnTree: FlowTree = {
  id: fn('f'),
  name: 'f',
  signature: 'f(client)',
  file: 'core:f.ts',
  lines: [1, 20],
  head: [1, 1],
  nodes: [guard('s0', 'if (!client)', [thrown('s0t0', 'TokenError(invalid_client)')]), call('s1', 'verify'), returned('s2', 'return client')],
};

/** The diagram of a frame as the flow view draws it: steps folded, guards on one line. */
function diagramOf(tree: FlowTree): Diagram {
  return frameDiagram(tree, '', undefined, { words, hasFrame: () => true });
}

/** The nodes of a chart as `id shape: lines | detail` (the detail in full). */
function nodesOf(chart: Chart): string[] {
  return chart.nodes.map((node) => `${node.id} ${node.shape}: ${node.lines.join(' / ')}${node.detail === undefined ? '' : ` | ${node.detailFull ?? node.detail}`}`);
}

/** The arrows of a chart as `from → to label (kind)`. */
function edgesOf(chart: Chart): string[] {
  return chart.edges.map((edge) => `${edge.from} → ${edge.to}${edge.label === undefined ? '' : ` ${edge.label}`} (${edge.kind})`);
}

describe('flowChart', () => {
  it('should draw the start as the endpoint, a step as a box saying its kind and values, and every exit as a terminal of its own', () => {
    const chart = flowChart(diagramOf(endpoint), endpoint, { words, steps, start: 'POST /token', answers: true });
    expect(nodesOf(chart)).toEqual([
      'start start: POST /token',
      'n:s0b0 process: リクエストを読む | 読み取り · → params, authorization',
      'n:s0b1 process: クライアントを確かめる | 検証 · params, authorization → client, unused',
      'n:s0b2 process: すぐ応答するか決める | 振り分け · params, client を読む',
      'n:s0b3 process: 応答する | 応答 · client を読む',
      'x:n:s0b1|0 failure: 失敗: TokenError(invalid_client)',
      'x:n:s0b2|0 end: 応答して終わる | early を返す',
      'x:n:s0b3|0 end: 応答して終わる | respond(c, body) を返す',
      'x:g:s0|0 end: 応答して終わる | respondError(c, error) を返す',
    ]);
  });

  it('should label the arrows between steps with the values handed on, an exit with its side, and the way on with the other side', () => {
    const chart = flowChart(diagramOf(endpoint), endpoint, { words, steps, start: 'POST /token', answers: true });
    expect(edgesOf(chart)).toEqual([
      'start → n:s0b0 (flow)',
      'n:s0b0 → n:s0b1 params, authorization (flow)',
      'n:s0b1 → n:s0b2 client (flow)',
      'n:s0b2 → n:s0b3 応答なし (flow)',
      'n:s0b1 → x:n:s0b1|0 失敗 (error)',
      'n:s0b2 → x:n:s0b2|0 応答した (branch)',
      'n:s0b3 → x:n:s0b3|0 応答した (branch)',
      'g:s0 → x:g:s0|0 例外 (error)',
    ]);
    expect(chart.edges.filter((edge) => edge.exit === true)).toHaveLength(4);
  });

  it('should cut a detail too long for its box with an ellipsis, and keep it whole for the card', () => {
    const long: ChartStep[] = steps.map((item) => (item.id === 'check' ? { ...item, produces: ['tokenClient', 'authenticatedClientId', 'refreshTokenRequest'] } : item));
    const node = flowChart(diagramOf(endpoint), endpoint, { words, steps: long, answers: true }).nodes.find((candidate) => candidate.id === 'n:s0b1');
    expect(node?.detail?.endsWith('…')).toBe(true);
    expect(node?.detailFull).toBe('検証 · params, authorization → tokenClient, authenticatedClientId, refreshTokenRequest');
  });

  it('should keep the exits of the boxes of a region inside it, and put the exit of its catch outside it', () => {
    const chart = flowChart(diagramOf(endpoint), endpoint, { words, steps, start: 'POST /token', answers: true });
    expect(chart.groups.map((group) => [group.id, group.title, group.members])).toEqual([['g:s0', '例外を捕まえる範囲', ['x:n:s0b1|0', 'x:n:s0b2|0', 'x:n:s0b3|0', 'n:s0b0', 'n:s0b1', 'n:s0b2', 'n:s0b3']]]);
    expect(chart.nodes.find((node) => node.id === 'x:g:s0|0')?.group).toBeUndefined();
    expect(chart.nodes.find((node) => node.id === 'x:n:s0b2|0')).toMatchObject({ of: 'n:s0b2', row: 0, ends: ['s0b2s1t0'], exitCode: 'return early', group: 'g:s0' });
  });

  it('should draw a guard as a rhombus with its condition, its failure beside it on the arrow of its side, and a return as an end', () => {
    const chart = flowChart(diagramOf(fnTree), fnTree, { words });
    expect(nodesOf(chart)).toEqual([
      'start start: f(client) | 関数 f の説明',
      'n:s0 decision: !client',
      'n:s1 process: クライアントを確かめる | verify(…)',
      'n:s2 end: 返して終わる | client を返す',
      'x:n:s0|0 failure: 失敗: TokenError(invalid_client)',
    ]);
    expect(edgesOf(chart)).toEqual(['start → n:s0 (flow)', 'n:s0 → n:s1 不成立 (flow)', 'n:s1 → n:s2 (flow)', 'n:s0 → x:n:s0|0 成立 (error)']);
    expect(chart.edges[1]?.side).toEqual({ node: 's0', side: 'false' });
  });
});

describe('stepValues and stepDetail', () => {
  it('should say what a step reads and hands on, and its kind before', () => {
    expect(stepValues({ consumes: ['a', 'b'], produces: ['c'] })).toBe('a, b → c');
    expect(stepValues({ consumes: ['a'], produces: [] })).toBe('a を読む');
    expect(stepValues({ consumes: [], produces: ['c'] })).toBe('→ c');
    expect(stepValues({ consumes: [], produces: [] })).toBe('');
    expect(stepDetail({ id: 's', kind: 'validate', consumes: ['a'], produces: ['b'] })).toBe('検証 · a → b');
    expect(stepDetail({ id: 's', kind: 'respond', consumes: [], produces: [] })).toBe('応答');
  });
});

describe('decisionLines', () => {
  it('should keep a short condition on one line and wrap a long one into two lines, the first one whole', () => {
    expect(decisionLines('!client', true)).toEqual(['!client']);
    const lines = decisionLines('「Content-Type がフォームの形式」が成り立たないか、ボディが空のとき', false);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.endsWith('…')).toBe(false);
    expect(lines.join('').replace('…', '').length).toBeGreaterThan(20);
  });
});

describe('layoutChart', () => {
  it('should put every exit beside the box it leaves, at its height, and keep the flow in one column', () => {
    const chart = flowChart(diagramOf(endpoint), endpoint, { words, steps, start: 'POST /token', answers: true });
    const placed = layoutChart(chart);
    const at = new Map(placed.boxes.map((box) => [box.id, box]));
    const middle = (id: string) => (at.get(id)?.y ?? 0) + (at.get(id)?.height ?? 0) / 2;
    const flow = ['n:s0b0', 'n:s0b1', 'n:s0b2', 'n:s0b3'].map((id) => at.get(id)?.x);
    expect(new Set(flow).size).toBe(1);
    for (const exit of ['n:s0b1', 'n:s0b2', 'n:s0b3']) {
      expect(Math.abs(middle(`x:${exit}|0`) - middle(exit))).toBeLessThan(1);
      expect(at.get(`x:${exit}|0`)?.x).toBeGreaterThan((at.get(exit)?.x ?? 0) + (at.get(exit)?.width ?? 0));
    }
    // The exit of the catch goes after the region, and the region holds the exits of its boxes.
    const region = placed.groups.find((group) => group.id === 'g:s0');
    expect(at.get('x:g:s0|0')?.y).toBeGreaterThan((region?.y ?? 0) + (region?.height ?? 0));
    for (const exit of ['x:n:s0b1|0', 'x:n:s0b2|0', 'x:n:s0b3|0']) expect((at.get(exit)?.x ?? 0) + (at.get(exit)?.width ?? 0)).toBeLessThanOrEqual((region?.x ?? 0) + (region?.width ?? 0));
    // No two nodes overlap, and every arrow is drawn.
    const overlapping = placed.boxes.flatMap((a, index) => placed.boxes.slice(index + 1).filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map((b) => `${a.id}×${b.id}`));
    expect(overlapping).toEqual([]);
    expect(placed.arrows.map((arrow) => arrow.index)).toEqual(chart.edges.map((_, index) => index));
  });

  it('should meet a rhombus at its corners', () => {
    const chart = flowChart(diagramOf(fnTree), fnTree, { words });
    const placed = layoutChart(chart);
    const rhombus = placed.boxes.find((box) => box.id === 'n:s0');
    const into = placed.arrows.find((arrow) => chart.edges[arrow.index]?.to === 'n:s0');
    const side = placed.arrows.find((arrow) => chart.edges[arrow.index]?.to === 'x:n:s0|0');
    expect(rhombus?.width).toBe(DECISION_WIDTH);
    expect(into?.points.at(-1)).toEqual({ x: (rhombus?.x ?? 0) + (rhombus?.width ?? 0) / 2, y: rhombus?.y });
    expect(side?.points[0]).toEqual({ x: (rhombus?.x ?? 0) + (rhombus?.width ?? 0), y: (rhombus?.y ?? 0) + (rhombus?.height ?? 0) / 2 });
  });
});

describe('chartWay', () => {
  const diagram = diagramOf(endpoint);
  const chart = flowChart(diagram, endpoint, { words, steps, start: 'POST /token', answers: true });
  /** The scenes of a walk of the endpoint along a choice, a scene a node of the chart. */
  const scenesFor = (decisions: Record<string, string>) => scenesOf(walkTrace(endpoint, decisions, { open: [], trees: new Map() }), (stop) => boxOf(diagram, stop.node.id)?.id);

  it('should take the request in at the start, along the arrows between its scenes, and out at the exit its last scene ends at', () => {
    const scenes = scenesFor({});
    const way = chartWay(chart, scenes, '');
    expect(scenes.map((scene) => scene.shape)).toEqual(['n:s0b0', 'n:s0b1', 'n:s0b2', 'n:s0b3']);
    expect([...way.nodes.keys()]).toEqual(['start', 'n:s0b0', 'n:s0b1', 'n:s0b2', 'n:s0b3', 'x:n:s0b3|0']);
    expect([...way.edges].map(([edge, scene]) => `${edgesOf(chart)[edge]} @${scene}`)).toEqual([
      'start → n:s0b0 (flow) @0',
      'n:s0b0 → n:s0b1 params, authorization (flow) @1',
      'n:s0b1 → n:s0b2 client (flow) @2',
      'n:s0b2 → n:s0b3 応答なし (flow) @3',
      'n:s0b3 → x:n:s0b3|0 応答した (branch) @3',
    ]);
    expect([...way.exits]).toEqual([[3, 'x:n:s0b3|0']]);
  });

  it('should end at the failure of a box and then at the exit of the catch that takes it', () => {
    const scenes = scenesFor({ s0b1s0: 'true' });
    const way = chartWay(chart, scenes, '');
    expect(scenes.map((scene) => [scene.shape, scene.tone])).toEqual([
      ['n:s0b0', 'normal'],
      ['n:s0b1', 'error'],
      ['g:s0', 'caught'],
    ]);
    expect([...way.exits]).toEqual([
      [1, 'x:n:s0b1|0'],
      [2, 'x:g:s0|0'],
    ]);
  });

  it('should tell the nodes and the arrows taken, travelled and ahead at a scene, the start staying taken', () => {
    const way = chartWay(chart, scenesFor({}), '');
    const at = wayAt(way, 1);
    expect(Object.fromEntries(at.nodes)).toEqual({ start: 'visited', 'n:s0b0': 'visited', 'n:s0b1': 'current', 'n:s0b2': 'ahead', 'n:s0b3': 'ahead', 'x:n:s0b3|0': 'ahead' });
    expect([...at.edges.values()]).toEqual(['taken', 'travel', 'ahead', 'ahead', 'ahead']);
    expect(Object.fromEntries(wayAt(way, 3).nodes)).toMatchObject({ 'n:s0b3': 'current', 'x:n:s0b3|0': 'exit' });
  });

  it('should leave a frame with no scene in it without a way', () => {
    const way = chartWay(chart, scenesFor({}), 'other');
    expect(way.nodes.size + way.edges.size + way.exits.size).toBe(0);
  });
});
