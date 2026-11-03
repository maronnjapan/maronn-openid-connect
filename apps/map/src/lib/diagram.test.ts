import { describe, expect, it } from 'vitest';
import type { Decisions, FlowTree, FrameChange, FrameChangeEntry, MapData, TreeNode } from '../types';
import { indexChanges } from './changes';
import { activeOf, boxAction, boxHeight, boxOf, frameDiagram, markOfBox, spokenLabel, type Diagram, type DiagramNode } from './diagram';
import { layoutGraph, type LayoutDirection } from './graph';
import { branchesOf, isDecision, nodesOn } from './trace';

const fn = (name: string) => `core:f.ts#${name}`;
const call = (id: string, callee: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'call', lines: [2, 2], code: `${callee}()`, target: { kind: 'function', id: fn(callee) }, ...extra });
const action = (id: string, code: string): TreeNode => ({ id, kind: 'action', lines: [2, 2], code });
const returned = (id: string, code: string, pre?: TreeNode[]): TreeNode => ({ id, kind: 'return', lines: [3, 3], code, ...(pre === undefined ? {} : { pre }) });
const thrown = (id: string, code: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'throw', lines: [3, 3], code, ...extra });
const decide = (id: string, code: string, form: TreeNode['form'], yes: TreeNode[], no: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({
  id,
  kind: 'if',
  lines: [4, 6],
  code,
  subject: code,
  form,
  branches: [{ key: 'true', label: '成立', nodes: yes }, { key: 'false', label: '不成立', nodes: no }],
  ...extra,
});
const step = (id: string, label: string, nodes: TreeNode[]): TreeNode => ({ id, kind: 'block', lines: [2, 9], code: `[${id}]`, text: label, step: { id: `step-${id}`, label }, branches: [{ key: 'body', label, nodes }] });
const attempt = (id: string, body: TreeNode[], handler: TreeNode[]): TreeNode => ({ id, kind: 'try', lines: [1, 20], code: 'try … catch', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: body }, { key: 'catch', label: '例外が起きたとき', nodes: handler }] });
const loop = (id: string, code: string, body: TreeNode[]): TreeNode => ({ id, kind: 'loop', lines: [5, 7], code, subject: code, branches: [{ key: 'body', label: '繰り返す', nodes: body }, { key: 'skip', label: '繰り返さない', nodes: [] }] });
const frameOf = (nodes: TreeNode[], signature = 'f(x)'): FlowTree => ({ id: 'core:f.ts#f', name: 'f', signature, file: 'core:f.ts', lines: [1, 40], head: [1, 1], nodes });
const hasFrame = () => true;

const boxes = (diagram: Diagram) => diagram.nodes.map((node) => [node.id, node.title, node.tone]);
const arrows = (diagram: Diagram) => diagram.edges.map((arrow) => `${arrow.from}→${arrow.to}${arrow.label === undefined ? '' : ` ${arrow.label}`} (${arrow.kind})`);
const rows = (diagram: Diagram) => diagram.nodes.flatMap((node) => node.rows.map((row) => `${node.id}: ${row.text} (${row.tone})`));
const box = (diagram: Diagram, id: string) => diagram.nodes.find((node) => node.id === id) as DiagramNode;
const isExit = (node: TreeNode) => (node.kind === 'return' && node.local !== true) || node.kind === 'throw';

/** The decisions and the exits of a frame the diagram shows nowhere: neither a box, nor a row (its side, its ends), nor inside a folded step. */
function lost(tree: FlowTree, diagram: Diagram, enabled?: ReadonlySet<string>): string[] {
  const drawn = new Set(diagram.nodes.map((node) => node.node));
  const all = diagram.nodes.flatMap((node) => node.rows);
  const sides = new Set(all.map((row) => row.side?.node));
  const ends = new Set(all.flatMap((row) => row.ends));
  const folded = new Set([...diagram.nodes.filter((node) => node.step?.open === false).map((node) => node.node), ...all.map((row) => row.step)]);
  const walk = (nodes: readonly TreeNode[], inside: boolean): string[] =>
    nodesOn(nodes, enabled).flatMap((node) => [
      ...(!inside && ((isDecision(node) && !drawn.has(node.id) && !sides.has(node.id)) || (isExit(node) && !drawn.has(node.id) && !ends.has(node.id))) ? [node.id] : []),
      ...walk(node.pre ?? [], inside || folded.has(node.id)),
      ...branchesOf(node, enabled).flatMap((branch) => walk(branch.nodes, inside || folded.has(node.id))),
    ]);
  return walk(tree.nodes, false);
}

/** Every choice of one side of one decision of a frame. */
function everySide(tree: FlowTree): Decisions[][] {
  const walk = (nodes: readonly TreeNode[]): Decisions[][] =>
    nodes.flatMap((node) => [
      ...(isDecision(node) ? (node.branches ?? []).filter((branch) => branch.always !== true).map((branch) => [{ [node.id]: branch.key }]) : []),
      ...walk(node.pre ?? []),
      ...(node.branches ?? []).flatMap((branch) => walk(branch.nodes)),
    ]);
  return walk(tree.nodes);
}

/** Where the boxes of a diagram go, sized by boxHeight, when the arrows a choice runs through are drawn. */
function placed(diagram: Diagram, tree: FlowTree, choices: Decisions[], direction: LayoutDirection) {
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const layout = layoutGraph(diagram.nodes, diagram.edges, activeOf(diagram, tree, '', choices).edges, direction, { height: (id, width) => boxHeight(byId.get(id) as DiagramNode, width) });
  return { boxes: layout.boxes, width: layout.width, height: layout.height, boxWidth: layout.boxWidth };
}

/** Two actions, a fork, a try whose catch rethrows, a return. */
const tree = frameOf([
  action('s0', 'const a = 1'),
  action('s1', 'const b = 2'),
  decide('s2', 'if (a)', 'fork', [call('s2t0', 'g')]),
  attempt('s3', [call('s3b0', 'h')], [thrown('s3h0', 'throw error', { error: 'error', rethrow: true })]),
  returned('s4', 'return b'),
]);

/** A guard with the call of its condition, a call with a call as its argument, a guard that throws, a return. */
const checks = frameOf([
  decide('s0', 'if (!isX(y))', 'guard', [returned('s0t0', 'return x')], [], { pre: [call('s0i0', 'isX')] }),
  call('s1', 'f', { code: 'f(g(y))', pre: [call('s1i0', 'g')] }),
  decide('s2', 'if (!y)', 'guard', [thrown('s2t0', 'throw invalid()', { pre: [call('s2t0i0', 'invalid')] })]),
  returned('s3', 'return y'),
]);

/** Every kind of decision, side by side: a guard, a fork of two boxes, a fork that ends on one side, a switch, a loop with a guard inside, a step in a try. */
const mixed = frameOf([
  decide('s0', 'if (!isX(y))', 'guard', [thrown('s0t0', 'throw invalid()')], [], { pre: [call('s0i0', 'isX')] }),
  decide('s1', 'if (a)', 'fork', [call('s1t0', 'left')], [call('s1e0', 'right')]),
  decide('s2', 'if (b)', 'fork', [returned('s2t0', 'return b')], [call('s2e0', 'other')]),
  {
    id: 's3',
    kind: 'switch',
    lines: [10, 14],
    code: 'switch (kind)',
    subject: 'kind',
    branches: [
      { key: 'c0', label: "case 'x'", nodes: [returned('s3c0s0', 'return x')] },
      { key: 'c1', label: "case 'y'", nodes: [call('s3c1s0', 'y')] },
      { key: 'default', label: 'default', nodes: [] },
    ],
  },
  loop('s4', 'for (const z of zs)', [decide('s4l0', 'if (!z)', 'guard', [thrown('s4l0t0', 'throw missing()')]), call('s4l1', 'each')]),
  attempt('s5', [step('s5b0', '確かめる', [call('s5b0s0', 'check'), decide('s5b0s1', 'if (done)', 'guard', [returned('s5b0s1t0', 'return done')])])], [thrown('s5h0', 'throw error', { rethrow: true })]),
  returned('s6', 'return last'),
]);

describe('frameDiagram', () => {
  const diagram = frameDiagram(tree, '', undefined, { hasFrame });
  const edge = (index: number) => diagram.edges[index];

  it('should draw a box for a node, one box for a run of actions, arrows from each side of a decision and a catch that ends at once as a red row', () => {
    expect(boxes(diagram)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', '処理 ×2', 'normal'],
      ['n:s2', 'if (a)', 'normal'],
      ['n:s2t0', 'g()', 'normal'],
      ['n:s3', 'try', 'normal'],
      ['n:s3b0', 'h()', 'normal'],
      ['n:s4', 'return b', 'end'],
    ]);
    expect(arrows(diagram)).toEqual([
      'start→n:s0 (flow)',
      'n:s0→n:s2 (flow)',
      'n:s2→n:s2t0 成立 (branch)',
      'n:s2t0→n:s3 (flow)',
      'n:s2→n:s3 不成立 (branch)',
      'n:s3→n:s3b0 (flow)',
      'n:s3b0→n:s4 (flow)',
    ]);
    expect(box(diagram, 'n:s3').rows).toEqual([{ text: '例外 → throw error', full: '例外 → throw error', tone: 'error', side: { node: 's3', side: 'catch' }, ends: ['s3h0'] }]);
    expect(box(diagram, 'n:s0').holds).toEqual(['s0', 's1']);
    expect(box(diagram, 'n:s2t0').opens).toEqual({ node: 's2t0', fn: fn('g') });
    expect(box(diagram, 'n:s2t0').calls).toEqual([fn('g')]);
    expect(diagram.sides.get(4)).toEqual({ node: 's2', side: 'false' });
    expect(edge(4)?.kind).toBe('branch');
  });

  it('should key a diagram by its frame, so a view of another frame starts afresh, and keep the key whatever the reader opens', () => {
    expect(diagram.key).toBe('frame:core:f.ts#f:');
    expect(frameDiagram(tree, 's1n0').key).toBe('frame:core:f.ts#f:s1n0');
    expect(frameDiagram(tree, '', undefined, { toggled: new Set(['s3']), changed: (id) => id === 's2' }).key).toBe('frame:core:f.ts#f:');
  });

  it('should open the frame of a call only when its callee has one', () => {
    expect(box(frameDiagram(tree, ''), 'n:s2t0').opens).toBeUndefined();
    expect(box(frameDiagram(tree, '', undefined, { hasFrame: (id) => id === fn('h') }), 'n:s3b0').opens).toEqual({ node: 's3b0', fn: fn('h') });
  });

  it('should fold a guard into one box with its calls, a row for its side, and one arrow out', () => {
    const folded = frameDiagram(checks, '');
    expect(boxes(folded)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', 'if (!isX(y))', 'normal'],
      ['n:s1i0', 'g()', 'normal'],
      ['n:s1', 'f()', 'normal'],
      ['n:s2', 'if (!y)', 'normal'],
      ['n:s3', 'return y', 'end'],
    ]);
    expect(rows(folded)).toEqual(['n:s0: → return x (end)', 'n:s2: → throw invalid() (error)']);
    expect(arrows(folded)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1i0 (flow)', 'n:s1i0→n:s1 (flow)', 'n:s1→n:s2 (flow)', 'n:s2→n:s3 (flow)']);
    expect(box(folded, 'n:s0').holds).toEqual(['s0', 's0i0', 's0t0']);
    expect(box(folded, 'n:s0').calls).toEqual([fn('isX')]);
    expect(box(folded, 'n:s0').rows[0]?.side).toEqual({ node: 's0', side: 'true' });
    expect(box(folded, 'n:s2').holds).toEqual(['s2', 's2t0', 's2t0i0']);
    expect(box(frameDiagram(checks, '', undefined, { hasFrame }), 'n:s0').opens).toBeUndefined();
  });

  it('should name the calls of a guard side before how it ends, and the side of a fork by how it ends', () => {
    const calling = frameOf([decide('s0', 'if (hashed)', 'guard', [call('s0t0', 'verifyHash', { code: 'await verifyHash(secret)' }), returned('s0t1', 'return')]), call('s1', 'compare')]);
    expect(box(frameDiagram(calling, ''), 'n:s0').rows.map((row) => [row.text, row.full])).toEqual([['→ verifyHash()、return', '→ verifyHash()、return']]);
    const forked = frameOf([decide('s0', 'if (expired)', 'fork', [call('s0t0', 'remove'), thrown('s0t1', 'throw expired()')], [call('s0e0', 'keep')])]);
    expect(box(frameDiagram(forked, ''), 'n:s0').rows.map((row) => [row.text, row.full])).toEqual([['成立 → throw expired()', '成立 → remove()、throw expired()']]);
  });

  it('should keep the other side of a guard that a feature forces, and end at a guard whose exit it forces', () => {
    const dispatch = frameOf([decide('s0', 'if (issued)', 'guard', [returned('s0t0', 'return issued')], [], { absent: { feature: 'x', side: 'false' } }), call('s1', 'next')]);
    expect(rows(frameDiagram(dispatch, '', new Set(['x'])))).toEqual(['n:s0: → return issued (end)']);
    expect(rows(frameDiagram(dispatch, '', new Set()))).toEqual([]);
    expect(arrows(frameDiagram(dispatch, '', new Set()))).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1 (flow)']);
    const required = frameOf([decide('s0', 'if (!ready)', 'guard', [thrown('s0t0', 'throw notReady()')], [], { absent: { feature: 'x', side: 'true' } }), call('s1', 'next')]);
    expect(arrows(frameDiagram(required, '', new Set()))).toEqual(['start→n:s0 (flow)']);
  });

  it('should fold an optional item into one box that names what it does', () => {
    const optional = frameDiagram(frameOf([decide('s0', 'if (x)', 'optional', [action('s0t0', 'a.b = x')]), call('s1', 'next')]), '');
    expect(box(optional, 'n:s0').subtitle).toBe('→ a.b = x');
    expect(box(optional, 'n:s0').rows).toEqual([]);
    expect(box(optional, 'n:s0').holds).toEqual(['s0', 's0t0']);
    expect(arrows(optional)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1 (flow)']);
  });

  it('should make a side that ends at once a row of its decision and still draw the side that goes on', () => {
    const forked = frameDiagram(frameOf([decide('s0', 'if (x)', 'fork', [returned('s0t0', 'return a')], [call('s0e0', 'b')]), call('s1', 'c')]), '');
    expect(boxes(forked)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', 'if (x)', 'normal'],
      ['n:s0e0', 'b()', 'normal'],
      ['n:s1', 'c()', 'normal'],
    ]);
    expect(box(forked, 'n:s0').rows).toEqual([{ text: '成立 → return a', full: '成立 → return a', tone: 'end', side: { node: 's0', side: 'true' }, ends: ['s0t0'] }]);
    expect(arrows(forked)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s0e0 不成立 (branch)', 'n:s0e0→n:s1 (flow)']);
  });

  it('should make a case that ends at once a row of its switch and keep the other cases as sides', () => {
    const folded = frameDiagram(mixed, '');
    expect(box(folded, 'n:s3').rows.map((row) => [row.text, row.side])).toEqual([["case 'x' → return x", { node: 's3', side: 'c0' }]]);
    expect(arrows(folded).filter((arrow) => arrow.startsWith('n:s3→'))).toEqual(["n:s3→n:s3c1s0 case 'y' (branch)", 'n:s3→n:s4 default (branch)']);
  });

  it('should make a catch that is one step a row naming the step, and draw the step as the side of the catch once it is opened', () => {
    const handler = step('s1h0', 'エラーで応答する', [
      decide('s1h0s0', 'if (error instanceof TokenError)', 'guard', [returned('s1h0s0t0', 'return oauthError(error)', [call('s1h0s0t0i0', 'oauthError')])]),
      returned('s1h0s1', "return oauthError('server_error')", [call('s1h0s1i0', 'oauthError')]),
    ]);
    const catching = frameOf([call('s0', 'load'), attempt('s1', [call('s1b0', 'work')], [handler])]);
    const folded = frameDiagram(catching, '');
    expect(box(folded, 'n:s1').rows).toEqual([{ text: '例外 → エラーで応答する', full: '例外 → エラーで応答する', tone: 'error', side: { node: 's1', side: 'catch' }, ends: ['s1h0s0t0', 's1h0s1'], step: 's1h0' }]);
    expect(box(folded, 'n:s1').holds).toEqual(['s1', 's1h0', 's1h0s0', 's1h0s0t0', 's1h0s0t0i0', 's1h0s1', 's1h0s1i0']);
    expect(lost(catching, folded)).toEqual([]);
    const opened = frameDiagram(catching, '', undefined, { toggled: new Set(['s1h0']) });
    expect(box(opened, 'n:s1').rows).toEqual([]);
    expect(boxes(opened).slice(4)).toEqual([
      ['n:s1h0', '▾ エラーで応答する', 'normal'],
      ['n:s1h0s0', 'if (error instanceof TokenError)', 'normal'],
      ['n:s1h0s1', "return oauthError('server_error')", 'end'],
    ]);
    expect(arrows(opened).slice(3)).toEqual(['n:s1→n:s1h0 例外が起きたとき (error)', 'n:s1h0→n:s1h0s0 (flow)', 'n:s1h0s0→n:s1h0s1 (flow)']);
    expect(lost(catching, opened)).toEqual([]);
  });

  it('should keep a side that decides something, or that holds two steps, as a side', () => {
    const deciding = frameOf([attempt('s0', [call('s0b0', 'work')], [decide('s0h0', 'if (error instanceof X)', 'guard', [thrown('s0h0t0', 'throw error', { rethrow: true })]), thrown('s0h1', 'throw wrap(error)')])]);
    const caught = frameDiagram(deciding, '');
    expect(box(caught, 'n:s0').rows).toEqual([]);
    expect(arrows(caught)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s0b0 (flow)', 'n:s0→n:s0h0 例外が起きたとき (error)', 'n:s0h0→n:s0h1 (flow)']);
    expect(lost(deciding, caught)).toEqual([]);
    const stepping = frameOf([decide('s0', 'if (x)', 'fork', [step('s0t0', '準備する', [call('s0t0s0', 'a')]), step('s0t1', '答える', [returned('s0t1s0', 'return b')])], [call('s0e0', 'c')])]);
    const drawn = frameDiagram(stepping, '');
    expect(box(drawn, 'n:s0').rows).toEqual([]);
    expect(boxes(drawn).map(([id]) => id)).toEqual(['start', 'n:s0', 'n:s0t0', 'n:s0t1', 'n:s0e0']);
    expect(lost(stepping, drawn)).toEqual([]);
  });

  it('should fold a loop of one call into one box and draw a loop with a guard inside in full', () => {
    const loops = frameDiagram(frameOf([loop('s0', 'for (const x of xs)', [call('s0l0', 'each')]), loop('s1', 'for (const y of ys)', [decide('s1l0', 'if (!y)', 'guard', [thrown('s1l0t0', 'throw missing()')]), call('s1l1', 'h')]), returned('s2', 'return done')]), '');
    expect(boxes(loops)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', 'for (const x of xs)', 'normal'],
      ['n:s1', 'for (const y of ys)', 'normal'],
      ['n:s1l0', 'if (!y)', 'normal'],
      ['n:s1l1', 'h()', 'normal'],
      ['n:s2', 'return done', 'end'],
    ]);
    expect([box(loops, 'n:s0').subtitle, box(loops, 'n:s0').code, box(loops, 'n:s0').holds]).toEqual(['each()', 'for (const x of xs)\neach()', ['s0', 's0l0']]);
    expect(arrows(loops)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1 (flow)', 'n:s1→n:s1l0 繰り返す (branch)', 'n:s1l0→n:s1l1 (flow)', 'n:s1l1→n:s2 (flow)', 'n:s1→n:s2 繰り返さない (branch)']);
  });

  it('should draw the arguments of a call folded into a decision as boxes before it', () => {
    const argued = frameOf([decide('s0', 'if (!isX(f(y)))', 'guard', [returned('s0t0', 'return x')], [], { pre: [call('s0i0', 'isX', { code: 'isX(f(y))', pre: [call('s0i0i0', 'f')] })] })]);
    const drawn = frameDiagram(argued, '');
    expect(boxes(drawn).map(([id, title]) => `${id} ${title}`)).toEqual(['start f(x)', 'n:s0i0i0 f()', 'n:s0 if (!isX(f(y)))']);
    expect(box(drawn, 'n:s0').holds).toEqual(['s0', 's0i0', 's0t0']);
    expect(arrows(drawn)).toEqual(['start→n:s0i0i0 (flow)', 'n:s0i0i0→n:s0 (flow)']);
  });

  it('should draw a decision evaluated before another before it, with the calls of its condition', () => {
    const inner: TreeNode = { id: 's0i0i0', kind: 'cond-expr', lines: [2, 2], code: 'p() && !q()', operator: '&&', pre: [call('s0i0i0i0', 'p')], branches: [{ key: 'true', label: '成立', nodes: [call('s0i0i0t0', 'q')] }, { key: 'false', label: '不成立', nodes: [] }] };
    const outer: TreeNode = { id: 's0i0', kind: 'cond-expr', lines: [2, 2], code: 'p() && !q() && r()', operator: '&&', pre: [inner], branches: [{ key: 'true', label: '成立', nodes: [call('s0i0t0', 'r')] }, { key: 'false', label: '不成立', nodes: [] }] };
    const nested = frameOf([returned('s0', 'return p() && !q() && r()', [outer])]);
    const drawn = frameDiagram(nested, '');
    expect(boxes(drawn).map(([id]) => id)).toEqual(['start', 'n:s0i0i0', 'n:s0i0i0t0', 'n:s0i0', 'n:s0i0t0', 'n:s0']);
    expect(box(drawn, 'n:s0i0i0').holds).toEqual(['s0i0i0', 's0i0i0i0']);
    expect(arrows(drawn)).toEqual([
      'start→n:s0i0i0 (flow)',
      'n:s0i0i0→n:s0i0i0t0 成立 (branch)',
      'n:s0i0i0t0→n:s0i0 (flow)',
      'n:s0i0i0→n:s0i0 不成立 (branch)',
      'n:s0i0→n:s0i0t0 成立 (branch)',
      'n:s0i0t0→n:s0 (flow)',
      'n:s0i0→n:s0 不成立 (branch)',
    ]);
    expect(lost(nested, drawn)).toEqual([]);
  });

  it('should keep a changed guard, a side holding a changed node and a changed action in boxes of their own, each with its badge', () => {
    const reviewed = frameOf([
      decide('s0', 'if (!a)', 'guard', [returned('s0t0', 'return a')]),
      decide('s1', 'if (!b)', 'guard', [returned('s1t0', 'return b')]),
      decide('s2', 'if (c)', 'fork', [returned('s2t0', 'return c')], [call('s2e0', 'd')]),
      action('s3', 'const e = 1'),
      action('s4', 'const f = 2'),
      action('s5', 'const g = 3'),
      action('s6', 'const h = 4'),
      returned('s7', 'return h', [call('s7i0', 'wrap')]),
    ]);
    const change: FrameChange = { kind: 'modified', marks: { s0: 'modified', s1t0: 'added', s2t0: 'modified', s4: 'added', s7i0: 'modified' }, removed: [], exprs: {}, hunks: {}, summary: [] };
    const drawn = frameDiagram(reviewed, '', undefined, { changed: (id) => change.marks[id] !== undefined });
    expect(boxes(drawn).map(([id, title]) => `${id} ${title}`)).toEqual([
      'start f(x)',
      'n:s0 if (!a)',
      'n:s0t0 return a',
      'n:s1 if (!b)',
      'n:s1t0 return b',
      'n:s2 if (c)',
      'n:s2t0 return c',
      'n:s2e0 d()',
      'n:s3 const e = 1',
      'n:s4 const f = 2',
      'n:s5 処理 ×2',
      'n:s7i0 wrap()',
      'n:s7 return h',
    ]);
    expect(rows(drawn)).toEqual([]);
    expect(drawn.nodes.map((node) => markOfBox(node, change, undefined)?.label ?? '')).toEqual(['', '変更', '', '', '追加', '', '変更', '', '', '追加', '', '変更', '']);
    const unmarked = frameDiagram(reviewed, '');
    expect(boxes(unmarked).map(([id, title]) => `${id} ${title}`)).toEqual(['start f(x)', 'n:s0 if (!a)', 'n:s1 if (!b)', 'n:s2 if (c)', 'n:s2e0 d()', 'n:s3 処理 ×4', 'n:s7 return h']);
    expect(rows(unmarked)).toEqual(['n:s0: → return a (end)', 'n:s1: → return b (end)', 'n:s2: 成立 → return c (end)']);
  });

  it('should draw a changed loop, and a loop whose body changed, in full', () => {
    const loops = frameOf([loop('s0', 'for (const x of xs)', [call('s0l0', 'each')]), loop('s1', 'for (const y of ys)', [call('s1l0', 'each')]), loop('s2', 'for (const z of zs)', [call('s2l0', 'each')])]);
    const marked = new Set(['s0', 's1l0']);
    const drawn = frameDiagram(loops, '', undefined, { changed: (id) => marked.has(id) });
    expect(boxes(drawn).map(([id]) => id)).toEqual(['start', 'n:s0', 'n:s0l0', 'n:s1', 'n:s1l0', 'n:s2']);
    expect(box(drawn, 'n:s2').holds).toEqual(['s2', 's2l0']);
  });

  it('should show every decision and every exit of a frame as a box, a row or inside a folded step', () => {
    expect(lost(tree, diagram)).toEqual([]);
    expect(lost(checks, frameDiagram(checks, ''))).toEqual([]);
    expect(lost(mixed, frameDiagram(mixed, ''))).toEqual([]);
    expect(lost(mixed, { ...frameDiagram(mixed, ''), nodes: [] })).toEqual(['s0', 's0t0', 's1', 's2', 's2t0', 's3', 's3c0s0', 's4', 's4l0', 's4l0t0', 's5', 's5b0s1', 's5b0s1t0', 's5h0', 's6']);
  });
});

describe('activeOf', () => {
  const diagram = frameDiagram(tree, '');
  const edge = (index: number) => diagram.edges[index];

  it('should take the boxes and arrows a choice runs through, leaving out the arrows of the sides it does not take', () => {
    const active = activeOf(diagram, tree, '', [{ s2: 'false', s3: 'try' }]);
    expect([...active.nodes].sort()).toEqual(['n:s0', 'n:s2', 'n:s3', 'n:s3b0', 'n:s4', 'start']);
    expect([...active.edges].map((index) => `${edge(index)?.from}→${edge(index)?.to}`)).toEqual(['start→n:s0', 'n:s0→n:s2', 'n:s2→n:s3', 'n:s3→n:s3b0', 'n:s3b0→n:s4']);
    expect([...active.rows]).toEqual([]);
    expect([...activeOf(diagram, tree, '', [{ s3: 'catch' }]).rows]).toEqual(['n:s3|0']);
  });

  it('should take everything when nothing is chosen, every row included', () => {
    const active = activeOf(diagram, tree, '', []);
    expect(active.nodes.size).toBe(diagram.nodes.length);
    expect(active.edges.size).toBe(diagram.edges.length);
    expect([...activeOf(frameDiagram(mixed, ''), mixed, '', []).rows]).toEqual(['n:s0|0', 'n:s2|0', 'n:s3|0', 'n:s4l0|0', 'n:s5|0', 'n:s5b0|0']);
  });

  it('should turn off the row of a guard whose other side is chosen, and turn it on and what follows off when its side is', () => {
    const folded = frameDiagram(checks, '');
    const passed = activeOf(folded, checks, '', [{ s2: 'false' }]);
    expect([passed.rows.has('n:s2|0'), passed.nodes.has('n:s2'), passed.nodes.has('n:s3')]).toEqual([false, true, true]);
    const throwing = activeOf(folded, checks, '', [{ s2: 'true' }]);
    expect([throwing.rows.has('n:s2|0'), throwing.nodes.has('n:s2'), throwing.nodes.has('n:s3')]).toEqual([true, true, false]);
    expect([...throwing.edges].map((index) => folded.edges[index]?.to)).toEqual(['n:s0', 'n:s1i0', 'n:s1', 'n:s2']);
  });

  it('should place every box the same for no choice and for each side of each decision', () => {
    const folded = frameDiagram(mixed, '');
    const choices = everySide(mixed);
    expect(choices.length).toBe(17);
    expect(new Set(choices.map((choice) => [...activeOf(folded, mixed, '', choice).edges].join())).size).toBeGreaterThan(1);
    expect(choices.map((choice) => placed(folded, mixed, choice, 'TB'))).toEqual(choices.map(() => placed(folded, mixed, [], 'TB')));
    expect(choices.map((choice) => placed(folded, mixed, choice, 'LR'))).toEqual(choices.map(() => placed(folded, mixed, [], 'LR')));
    expect(placed(folded, mixed, [], 'TB').boxWidth).toBe(200);
  });
});

/** The body of /token in small: a step of one call, a step of a call and a guard, a step whose `??` calls on one side, a step that responds; a catch that answers. */
const token: FlowTree = {
  ...frameOf(
    [
      attempt(
        's0',
        [
          step('s0b0', 'リクエストを解析する', [call('s0b0s0', 'parse', { code: 'const params = await parse(c)' })]),
          step('s0b1', 'トークン交換', [call('s0b1s0', 'exchange'), decide('s0b1s1', 'if (exchanged)', 'guard', [returned('s0b1s1t0', 'return exchanged')])]),
          step('s0b2', '認可コードを検証する', [
            { id: 's0b2s0', kind: 'cond-expr', lines: [5, 5], code: 'const request = refresh ?? (await code())', operator: '??', branches: [{ key: 'defined', label: '値あり', nodes: [] }, { key: 'nullish', label: 'null または undefined', nodes: [call('s0b2s0n0', 'code')] }] },
          ]),
          step('s0b3', '応答する', [returned('s0b3s0', 'return respond(c)', [call('s0b3s0i0', 'respond')])]),
        ],
        [returned('s0h0', 'return respondError(c, error)', [call('s0h0i0', 'respondError')])],
      ),
    ],
    'POST /token',
  ),
  id: 'endpoint:token',
  name: 'POST /token',
};

describe('the steps of an endpoint', () => {
  const diagram = frameDiagram(token, '', undefined, { hasFrame });

  it('should draw one box a step, the catch as a red row of the try, and no arrow out of the step that ends', () => {
    expect(boxes(diagram)).toEqual([
      ['start', 'POST /token', 'start'],
      ['n:s0', 'try', 'normal'],
      ['n:s0b0', 'リクエストを解析する', 'normal'],
      ['n:s0b1', 'トークン交換', 'normal'],
      ['n:s0b2', '▸ 認可コードを検証する', 'normal'],
      ['n:s0b3', '応答する', 'normal'],
    ]);
    expect(rows(diagram)).toEqual(['n:s0: 例外 → return respondError(c, error) (error)', 'n:s0b1: → return exchanged (end)', 'n:s0b3: → return respond(c) (end)']);
    expect(arrows(diagram)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s0b0 (flow)', 'n:s0b0→n:s0b1 (flow)', 'n:s0b1→n:s0b2 (flow)', 'n:s0b2→n:s0b3 (flow)']);
    expect(box(diagram, 'n:s0b2').holds).toEqual(['s0b2', 's0b2s0', 's0b2s0n0']);
    expect(box(diagram, 'n:s0b1').calls).toEqual([fn('exchange')]);
    expect(lost(token, diagram)).toEqual([]);
  });

  it('should let a step of one call open the frame of that call, and any other step toggle', () => {
    expect(box(diagram, 'n:s0b0').opens).toEqual({ node: 's0b0s0', fn: fn('parse') });
    expect(box(diagram, 'n:s0b1').opens).toEqual({ node: 's0b1s0', fn: fn('exchange') });
    expect(box(diagram, 'n:s0b3').opens).toEqual({ node: 's0b3s0i0', fn: fn('respond') });
    expect(box(diagram, 'n:s0b2').opens).toBeUndefined();
    expect(box(diagram, 'n:s0b2').step).toEqual({ id: 's0b2', open: false, toggles: true });
    expect(box(diagram, 'n:s0b0').step).toEqual({ id: 's0b0', open: false, toggles: false });
    expect(boxAction(box(diagram, 'n:s0b2'))).toBe('toggle');
  });

  it('should let a step whose only call is on the way out of its guard toggle, and a step whose call is the condition of its guard open it', () => {
    const exiting = frameOf([step('s0', '明示的な承認を求める', [decide('s0s0', "if (action !== 'approve')", 'guard', [returned('s0s0t0', 'return redirectToErrorPage(…)', [call('s0s0t0i0', 'redirectToErrorPage')])])]), call('s1', 'approve')]);
    const exit = box(frameDiagram(exiting, '', undefined, { hasFrame }), 'n:s0');
    expect([exit.title, exit.opens, boxAction(exit), exit.rows.map((row) => row.text)]).toEqual(['▸ 明示的な承認を求める', undefined, 'toggle', ['→ return redirectToErrorPage(…)']]);
    const checking = frameOf([step('s0', '確かめる', [decide('s0s0', 'if (!(await verify(x)))', 'guard', [returned('s0s0t0', 'return null')], [], { pre: [call('s0s0i0', 'verify')] })])]);
    const check = box(frameDiagram(checking, '', undefined, { hasFrame }), 'n:s0');
    expect([check.title, check.opens, boxAction(check)]).toEqual(['確かめる', { node: 's0s0i0', fn: fn('verify') }, 'open']);
  });

  it('should let a step that calls a member besides its function toggle, not open the function', () => {
    const issue: TreeNode = { id: 's0s1', kind: 'call', lines: [3, 3], code: 'await issuer.issue(payload)', target: { kind: 'member', id: 'core:issuer.ts#Issuer.issue' } };
    const issuing = frameDiagram(frameOf([step('s0', 'アクセストークンを発行する', [call('s0s0', 'build'), issue])]), '', undefined, { hasFrame });
    expect([box(issuing, 'n:s0').title, box(issuing, 'n:s0').opens, box(issuing, 'n:s0').calls]).toEqual(['▸ アクセストークンを発行する', undefined, [fn('build')]]);
  });

  it('should draw no arrow out of a step that ends in a try or a switch', () => {
    const tried = frameOf([step('s0', '応答する', [attempt('s0s0', [returned('s0s0b0', 'return ok()')], [returned('s0s0h0', 'return fail()')])]), call('s1', 'after')]);
    expect(arrows(frameDiagram(tried, ''))).toEqual(['start→n:s0 (flow)']);
    const switched = frameOf([
      step('s0', '振り分ける', [
        {
          id: 's0s0',
          kind: 'switch',
          lines: [3, 6],
          code: 'switch (kind)',
          subject: 'kind',
          branches: [
            { key: 'c0', label: "case 'a'", nodes: [returned('s0s0c0s0', 'return a()')] },
            { key: 'default', label: 'default', nodes: [thrown('s0s0c1s0', 'throw unknown()')] },
          ],
        },
      ]),
      call('s1', 'after'),
    ]);
    expect(arrows(frameDiagram(switched, ''))).toEqual(['start→n:s0 (flow)']);
    expect(rows(frameDiagram(switched, ''))).toEqual(['n:s0: → 2 通りで終わる (end)']);
  });

  it('should draw a step the reader opens as its heading and its body, and fold it back when it is toggled again', () => {
    const opened = frameDiagram(token, '', undefined, { hasFrame, toggled: new Set(['s0b2']) });
    expect(boxes(opened).slice(4, 7)).toEqual([
      ['n:s0b2', '▾ 認可コードを検証する', 'normal'],
      ['n:s0b2s0', 'const request = refresh ?? (await code())', 'normal'],
      ['n:s0b2s0n0', 'code()', 'normal'],
    ]);
    expect([box(opened, 'n:s0b2').subtitle, box(opened, 'n:s0b2').holds, box(opened, 'n:s0b2').step]).toEqual(['', ['s0b2'], { id: 's0b2', open: true, toggles: true }]);
    expect(arrows(opened).slice(3)).toEqual(['n:s0b1→n:s0b2 (flow)', 'n:s0b2→n:s0b2s0 (flow)', 'n:s0b2s0→n:s0b2s0n0 null または undefined (branch)', 'n:s0b2s0→n:s0b3 値あり (branch)', 'n:s0b2s0n0→n:s0b3 (flow)']);
    expect(lost(token, opened)).toEqual([]);
    expect(frameDiagram(token, '', undefined, { hasFrame, toggled: new Set() })).toEqual(diagram);
  });

  it('should open a step that holds a changed node, its badge on the node, and let a toggle fold it to a box that toggles with the badge', () => {
    const change: FrameChange = { kind: 'modified', marks: { s0b1s1: 'modified' }, removed: [], exprs: {}, hunks: {}, summary: [] };
    const changed = (id: string) => change.marks[id] !== undefined;
    const opened = frameDiagram(token, '', undefined, { hasFrame, changed });
    expect(boxes(opened).slice(3, 7).map(([id, title]) => `${id} ${title}`)).toEqual(['n:s0b1 ▾ トークン交換', 'n:s0b1s0 exchange()', 'n:s0b1s1 if (exchanged)', 'n:s0b1s1t0 return exchanged']);
    expect(opened.nodes.slice(3, 7).map((node) => markOfBox(node, change, undefined)?.label ?? '')).toEqual(['', '', '変更', '']);
    expect(['n:s0b0', 'n:s0b2', 'n:s0b3'].map((id) => box(opened, id).step?.open)).toEqual([false, false, false]);
    expect(lost(token, opened)).toEqual([]);
    const folded = frameDiagram(token, '', undefined, { hasFrame, changed, toggled: new Set(['s0b1']) });
    expect([box(folded, 'n:s0b1').title, box(folded, 'n:s0b1').opens, boxAction(box(folded, 'n:s0b1'))]).toEqual(['▸ トークン交換', undefined, 'toggle']);
    expect(markOfBox(box(folded, 'n:s0b1'), change, undefined)?.label).toBe('変更');
    expect(lost(token, folded)).toEqual([]);
    const callChanged = frameDiagram(token, '', undefined, { hasFrame, changed: (id) => id === 's0b1s0', toggled: new Set(['s0b1']) });
    expect([box(callChanged, 'n:s0b1').title, box(callChanged, 'n:s0b1').opens, boxAction(box(callChanged, 'n:s0b1'))]).toEqual(['▸ トークン交換', undefined, 'toggle']);
  });

  it('should sum up the exits of a step: one by its code, several that read the same as ×n, others as how many', () => {
    const oauthError = (id: string, code: string) => returned(id, code, [call(`${id}i0`, 'oauthError', { code: code.replace('return ', '') })]);
    const parse = frameOf([
      step('s0', 'リクエストを解析する', [
        decide('s0s0', 'if (!isForm(request))', 'guard', [oauthError('s0s0t0', 'return oauthError(…)')], [], { pre: [call('s0s0i0', 'isForm')] }),
        decide('s0s1', 'if (duplicate)', 'guard', [oauthError('s0s1t0', "return oauthError('invalid_request', `…`)")]),
        decide('s0s2', 'if (!valid)', 'guard', [oauthError('s0s2t0', "return oauthError('invalid_grant')")]),
        action('s0s3', 'const params = raw'),
      ]),
      step('s1', '確かめる', [decide('s1s0', 'if (!a)', 'guard', [returned('s1s0t0', 'return a')]), decide('s1s1', 'if (!b)', 'guard', [thrown('s1s1t0', 'throw b()')])]),
      step('s2', '拒む', [decide('s2s0', 'if (!a)', 'guard', [thrown('s2s0t0', 'throw a()')]), decide('s2s1', 'if (!b)', 'guard', [thrown('s2s1t0', 'throw b()')])]),
    ]);
    const steps = frameDiagram(parse, '', undefined, { hasFrame });
    expect(steps.nodes.map((node) => node.rows)).toEqual([
      [],
      [{ text: '→ return oauthError(…) ×3', full: "→ return oauthError(…)、return oauthError('invalid_request', `…`)、return oauthError('invalid_grant')", tone: 'end', ends: ['s0s0t0', 's0s1t0', 's0s2t0'] }],
      [{ text: '→ 2 通りで終わる', full: '→ return a、throw b()', tone: 'end', ends: ['s1s0t0', 's1s1t0'] }],
      [{ text: '→ 2 通りで終わる', full: '→ throw a()、throw b()', tone: 'error', ends: ['s2s0t0', 's2s1t0'] }],
    ]);
    expect(box(steps, 'n:s0').title).toBe('▸ リクエストを解析する');
    expect(arrows(steps)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1 (flow)', 'n:s1→n:s2 (flow)']);
  });

  it('should open, toggle, select or do nothing by the kind of box', () => {
    const opened = frameDiagram(token, '', undefined, { hasFrame, toggled: new Set(['s0b2']) });
    const unopenable = frameDiagram(token, '', undefined, { toggled: new Set(['s0b2']) });
    expect([boxAction(box(diagram, 'start')), boxAction(box(diagram, 'n:s0')), boxAction(box(diagram, 'n:s0b0')), boxAction(box(diagram, 'n:s0b2'))]).toEqual(['none', 'select', 'open', 'toggle']);
    expect([boxAction(box(opened, 'n:s0b2')), boxAction(box(opened, 'n:s0b2s0')), boxAction(box(opened, 'n:s0b2s0n0'))]).toEqual(['toggle', 'select', 'open']);
    expect([boxAction(box(unopenable, 'n:s0b0')), boxAction(box(unopenable, 'n:s0b2s0n0'))]).toEqual(['toggle', 'select']);
  });
});

describe('boxOf', () => {
  it('should find the box that holds a node, else the box of its nearest ancestor', () => {
    const folded = frameDiagram(checks, '');
    expect(boxOf(folded, 's0t0')?.id).toBe('n:s0');
    expect(boxOf(folded, 's0i0')?.id).toBe('n:s0');
    expect(boxOf(folded, 's1i0')?.id).toBe('n:s1i0');
    expect(boxOf(folded, 's2t0i0')?.id).toBe('n:s2');
    expect(boxOf(folded, 's9')).toBeUndefined();
    const steps = frameDiagram(token, '');
    expect(boxOf(steps, 's0b2s0n0')?.id).toBe('n:s0b2');
    expect(boxOf(steps, 's0h0i0')?.id).toBe('n:s0');
    expect(boxOf(frameDiagram(tree, '', new Set()), 's1')?.id).toBe('n:s0');
    expect(boxOf(frameDiagram(token, '', undefined, { toggled: new Set(['s0b2']) }), 's0b2s0n0s1')?.id).toBe('n:s0b2s0n0');
  });
});

describe('boxHeight', () => {
  const sized = (title: string, subtitle: string, rowCount: number, tone: DiagramNode['tone'] = 'normal'): DiagramNode => ({
    id: 'n:s0',
    title,
    subtitle,
    code: title,
    tone,
    rows: Array.from({ length: rowCount }, () => ({ text: '→ return x', full: '→ return x', tone: 'end' as const, ends: ['s0t0'] })),
    holds: ['s0'],
    calls: [],
  });
  const long = 'validateAuthorizationCodeGrant(params, clientId)';

  it('should grow a box with its title, its subtitle and its rows', () => {
    expect(boxHeight(sized('f()', '', 0), 320)).toBe(36);
    expect(boxHeight(sized('f()', 'what it does', 0), 320)).toBe(48);
    expect(boxHeight(sized('f()', 'what it does', 2), 320)).toBe(80);
    expect(boxHeight(sized(long, 'what it does', 0), 320)).toBe(50);
    expect(boxHeight(sized(long, 'what it does', 1), 320)).toBe(66);
  });

  it('should wrap a title by the width and the badge, and keep the start one line', () => {
    const title = 'issueAuthorizationCodeResponse()';
    expect(boxHeight(sized(title, 'what it does', 0), 320)).toBe(48);
    expect(boxHeight(sized(title, 'what it does', 0), 200)).toBe(50);
    expect(boxHeight(sized(title, 'what it does', 0), 320, 80)).toBe(50);
    expect(boxHeight(sized(long, '', 0, 'start'), 200)).toBe(36);
  });
});

describe('spokenLabel', () => {
  it('should join the lines of a label with 。 and keep a single full stop after a line that ends with one', () => {
    expect(spokenLabel(['loadSigningKeys()', '用途ごとの署名鍵の集合を読み込み、検証して返す。', '押すと loadSigningKeys() の中を開く'])).toBe('loadSigningKeys()。用途ごとの署名鍵の集合を読み込み、検証して返す。押すと loadSigningKeys() の中を開く');
    expect(spokenLabel(['const key = keys.get(id)', 'Returns the key, or undefined when it is missing.', 'diff |= a[i]! ^ b[i]!'])).toBe('const key = keys.get(id)。Returns the key, or undefined when it is missing。diff |= a[i]! ^ b[i]!');
  });
});

describe('markOfBox', () => {
  const entry = (id: string, kind: FrameChangeEntry['kind']): FrameChangeEntry => ({ id, name: id.slice(id.indexOf('#') + 1), package: 'core', module: 'f.ts', line: 1, kind, summary: [], counts: {}, reach: [], documented: false, required: false });
  const data = {
    functions: {
      [fn('top')]: { id: fn('top'), name: 'top', sites: [['s0', fn('leaf')]], frame: 'f1' },
      [fn('leaf')]: { id: fn('leaf'), name: 'leaf', sites: [], frame: 'f2' },
    },
    bodies: {},
    changes: { base: { ref: 'origin/main', commit: 'abc' }, head: { commit: 'def', dirty: false }, notes: [], frames: [entry(fn('leaf'), 'modified')], unmatched: [], unknown: [], ambiguous: [], undocumented: [], outside: [], otherFiles: 0 },
  } as unknown as MapData;
  const changes = indexChanges(data);
  const change: FrameChange = { kind: 'modified', marks: { s0s1: 'modified' }, removed: [], exprs: {}, hunks: {}, summary: [] };
  const folded = frameDiagram(frameOf([step('s0', '準備する', [call('s0s0', 'top'), action('s0s1', 'const a = 1')]), call('s1', 'top'), call('s2', 'leaf'), action('s3', 'const b = 2')]), '', undefined, { changed: (id) => change.marks[id] !== undefined, toggled: new Set(['s0']) });

  it('should take the strongest of the badges of the nodes a box holds and of the frames its calls lead to', () => {
    expect(markOfBox(box(folded, 'n:s0'), change, changes)?.kind).toBe('line');
    expect(markOfBox(box(folded, 'n:s0'), change, changes)?.label).toBe('変更');
    expect(markOfBox(box(folded, 'n:s1'), change, changes)?.label).toBe('下で変更');
    expect(markOfBox(box(folded, 'n:s2'), change, changes)?.kind).toBe('modified');
    expect(markOfBox(box(folded, 'n:s3'), change, changes)).toBeUndefined();
    expect(markOfBox(box(folded, 'start'), change, changes)).toBeUndefined();
    expect(markOfBox(box(folded, 'n:s1'), undefined, undefined)).toBeUndefined();
  });
});
