import { describe, expect, it } from 'vitest';
import type { Decisions, FlowTree, FrameChange, FrameChangeEntry, MapData, TreeNode } from '../types';
import { indexChanges } from './changes';
import { activeOf, boxActions, boxHeight, boxLine, boxOf, exitTags, frameDiagram, isRegion, layoutDiagram, markOfBox, REGION_HEADER, regionLine, regionTags, spokenLabel, type Diagram, type DiagramGroup, type DiagramNode } from './diagram';
import type { LayoutBox, LayoutDirection, LayoutGroup } from './graph';
import { branchesOf, isDecision, nodesOn } from './trace';
import type { WordSource } from './words';

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
const guarded = (id: string, body: TreeNode[], final: TreeNode[]): TreeNode => ({ id, kind: 'try', lines: [1, 20], code: 'try … finally', subject: '例外', branches: [{ key: 'try', label: '例外なし', nodes: body }, { key: 'finally', label: '最後に必ず', nodes: final, always: true }] });
const loop = (id: string, code: string, body: TreeNode[]): TreeNode => ({ id, kind: 'loop', lines: [5, 7], code, subject: code, branches: [{ key: 'body', label: '繰り返す', nodes: body }, { key: 'skip', label: '繰り返さない', nodes: [] }] });
const frameOf = (nodes: TreeNode[], signature = 'f(x)'): FlowTree => ({ id: 'core:f.ts#f', name: 'f', signature, file: 'core:f.ts', lines: [1, 40], head: [1, 1], nodes });
const hasFrame = () => true;

const boxes = (diagram: Diagram) => diagram.nodes.map((node) => [node.id, node.title, node.tone]);
const arrows = (diagram: Diagram) => diagram.edges.map((arrow) => `${arrow.from}→${arrow.to}${arrow.label === undefined ? '' : ` ${arrow.label}`} (${arrow.kind})`);
const rows = (diagram: Diagram) => [...diagram.nodes, ...diagram.groups].flatMap((shape) => shape.rows.map((row) => `${shape.id}: ${row.full} (${row.tone})`));
const box = (diagram: Diagram, id: string) => diagram.nodes.find((node) => node.id === id) as DiagramNode;
const region = (diagram: Diagram, id: string) => diagram.groups.find((group) => group.id === id) as DiagramGroup;
const isExit = (node: TreeNode) => (node.kind === 'return' && node.local !== true) || node.kind === 'throw';

/** The decisions and the exits of a frame the diagram shows nowhere: neither a box, nor a region (a try), nor a row (its side, its ends), nor inside a folded step. */
function lost(tree: FlowTree, diagram: Diagram, enabled?: ReadonlySet<string>): string[] {
  const drawn = new Set([...diagram.nodes.map((node) => node.node), ...diagram.groups.map((group) => group.node)]);
  const all = [...diagram.nodes, ...diagram.groups].flatMap((shape) => shape.rows);
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

/** Where the boxes and regions of a diagram go, laid out as FlowDiagram does, when the arrows a choice runs through are drawn. */
function placed(diagram: Diagram, tree: FlowTree, choices: Decisions[], direction: LayoutDirection) {
  const layout = layoutDiagram(diagram, activeOf(diagram, tree, '', choices).edges, direction);
  return { boxes: layout.boxes, groups: layout.groups, width: layout.width, height: layout.height, boxWidth: layout.boxWidth };
}

/** Whether two rectangles overlap (touching edges do not). */
const overlaps = (a: LayoutBox | LayoutGroup, b: LayoutBox | LayoutGroup) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Whether a rectangle lies inside another with at least a margin around it. */
const encloses = (outer: LayoutBox | LayoutGroup, inner: LayoutBox | LayoutGroup, margin: number) =>
  inner.x - outer.x >= margin && inner.y - outer.y >= margin && outer.x + outer.width - (inner.x + inner.width) >= margin && outer.y + outer.height - (inner.y + inner.height) >= margin;

/** The words of the functions the fixtures call. */
const source = {
  functions: {
    [fn('g')]: { summary: 'g を行う。理由は二つある。' },
    [fn('verifyHash')]: { summary: 'ハッシュを確かめる。' },
    [fn('respondError')]: { summary: 'エラーで応答する。' },
  },
  members: {},
} as unknown as WordSource;

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

/** Tries side by side and inside one another: a try in a fork whose other side is a box, a try inside it whose catch goes on (drawn after it), a catch that ignores the exception, a try with only a finally. */
const nested = frameOf([
  decide('s0', 'if (a)', 'fork', [
    attempt('s0t0', [call('s0t0b0', 'load'), attempt('s0t0b1', [call('s0t0b1b0', 'parse')], [call('s0t0b1h0', 'log'), action('s0t0b1h1', 'parsed = fallback')]), call('s0t0b2', 'use')], [thrown('s0t0h0', 'throw error', { rethrow: true })]),
  ], [call('s0e0', 'other')]),
  attempt('s1', [call('s1b0', 'tryIt')], []),
  guarded('s2', [call('s2b0', 'open')], [call('s2f0', 'close')]),
  returned('s3', 'return done'),
]);

describe('frameDiagram', () => {
  const diagram = frameDiagram(tree, '', undefined, { hasFrame });
  const edge = (index: number) => diagram.edges[index];

  it('should draw a box for a node, one box read in words for statements in a row that say nothing in words, arrows from each side of a decision and the body of a try inside its region', () => {
    expect(boxes(diagram)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', 'a、b を用意する', 'normal'],
      ['n:s2', 'if (a)', 'normal'],
      ['n:s2t0', 'g()', 'normal'],
      ['n:s3b0', 'h()', 'normal'],
      ['n:s4', 'b を返す', 'end'],
    ]);
    expect(arrows(diagram)).toEqual([
      'start→n:s0 (flow)',
      'n:s0→n:s2 (flow)',
      'n:s2→n:s2t0 成立 (branch)',
      'n:s2t0→n:s3b0 (flow)',
      'n:s2→n:s3b0 不成立 (branch)',
      'n:s3b0→n:s4 (flow)',
    ]);
    expect(box(diagram, 'n:s0').holds).toEqual(['s0', 's1']);
    expect([box(diagram, 'n:s0').code, box(diagram, 'n:s0').text, box(diagram, 'n:s0').titleCode]).toEqual(['const a = 1\nconst b = 2', '`a`、`b` を用意する', false]);
    expect(box(diagram, 'n:s2t0').opens).toEqual({ node: 's2t0', fn: fn('g') });
    expect(box(diagram, 'n:s2t0').calls).toEqual([fn('g')]);
    expect(diagram.sides.get(4)).toEqual({ node: 's2', side: 'false' });
    expect(edge(4)?.kind).toBe('branch');
  });

  it('should draw a try as a region around the boxes of its body, its catch that ends at once a row of the region', () => {
    expect(diagram.groups).toEqual([
      {
        id: 'g:s3',
        node: 's3',
        members: ['n:s3b0'],
        title: '例外を捕まえる範囲',
        rows: [{ full: '例外 → 失敗: `error` を投げる', tone: 'error', side: { node: 's3', side: 'catch' }, ends: ['s3h0'] }],
        outcome: '例外 → 失敗: `error` を投げる',
        code: 'try … catch',
        holds: ['s3', 's3h0'],
        calls: [],
      },
    ]);
    expect(diagram.nodes.map((node) => node.group ?? '')).toEqual(['', '', '', '', 'g:s3', '']);
    expect(diagram.nodes.some((node) => node.node === 's3')).toBe(false);
    expect(lost(tree, diagram)).toEqual([]);
  });

  it('should key a diagram by its frame, so a view of another frame starts afresh, and keep the key whatever the reader opens', () => {
    expect(diagram.key).toBe('frame:core:f.ts#f:');
    expect(frameDiagram(tree, 's1n0').key).toBe('frame:core:f.ts#f:s1n0');
    expect(frameDiagram(tree, '', undefined, { toggled: new Set(['s3']), changed: (id) => id === 's2' }).key).toBe('frame:core:f.ts#f:');
  });

  it('should offer the frame of a call only when its callee has one', () => {
    expect(box(frameDiagram(tree, ''), 'n:s2t0').opens).toBeUndefined();
    expect(box(frameDiagram(tree, '', undefined, { hasFrame: (id) => id === fn('h') }), 'n:s3b0').opens).toEqual({ node: 's3b0', fn: fn('h') });
  });

  it('should title a box by the words of what it does, the first sentence of the JSDoc of what a call reaches, and keep the whole text for its card', () => {
    const worded = frameDiagram(frameOf([
      call('s0', 'g', { code: 'const x = g(y)' }),
      decide('s1', 'if (!x)', 'guard', [returned('s1t0', 'return respondError(c)', [call('s1t0i0', 'respondError')])], [], { text: '値が無ければエラーで応答する。理由。', from: 'comment' }),
      returned('s2', 'return respondError(c)', [call('s2i0', 'respondError')]),
      call('s3', 'unknown', { code: 'unknown(z)' }),
    ]), '', undefined, { words: source });
    expect(worded.nodes.map((node) => [node.id, node.title, node.titleCode, node.text])).toEqual([
      ['start', 'f(x)', false, undefined],
      ['n:s0', 'g を行う', false, 'g を行う。理由は二つある。'],
      ['n:s1', '値が無ければエラーで応答する', false, '値が無ければエラーで応答する。理由。'],
      ['n:s2', 'エラーで応答する', false, 'エラーで応答する。'],
      ['n:s3', 'unknown(z)', true, undefined],
    ]);
    expect(box(worded, 'n:s0').code).toBe('const x = g(y)');
    expect(box(worded, 'n:s1').rows.map((row) => row.full)).toEqual(['成立 → 終わり: エラーで応答する']);
    expect(box(frameDiagram(tree, ''), 'n:s2t0').title).toBe('g()');
  });

  it('should read statements in a row that say nothing in words as one box in words, keep one with a comment its own box, and show a lone one as code', () => {
    const settings = frameOf([
      action('s0', 'const a = 1'),
      action('s1', 'const b = 2'),
      { ...action('s2', 'x.y = a'), text: '既定の値を入れる。', from: 'comment' },
      action('s3', 'x.z = b'),
      action('s4', 'x.w = a'),
      call('s5', 'next'),
      action('s6', 'seen.add(key)'),
      action('s7', 'const k = 1'),
      call('s8', 'more'),
      action('s9', 'count += 1'),
    ]);
    const drawn = frameDiagram(settings, '');
    expect(drawn.nodes.map((node) => [node.id, node.title, node.titleCode])).toEqual([
      ['start', 'f(x)', false],
      ['n:s0', 'a、b を用意する', false],
      ['n:s2', '既定の値を入れる', false],
      ['n:s3', 'x.z、x.w に入れる', false],
      ['n:s5', 'next()', true],
      ['n:s6', '処理: k、seen.add(key)', false],
      ['n:s8', 'more()', true],
      ['n:s9', 'count += 1', true],
    ]);
    expect([box(drawn, 'n:s3').holds, box(drawn, 'n:s3').text, box(drawn, 'n:s2').text]).toEqual([['s3', 's4'], '`x.z`、`x.w` に入れる', '既定の値を入れる。']);
  });

  it('should fold a guard into one box with its calls, a row for its side, and one arrow out', () => {
    const folded = frameDiagram(checks, '');
    expect(boxes(folded)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', 'if (!isX(y))', 'normal'],
      ['n:s1i0', 'g()', 'normal'],
      ['n:s1', 'f(g(y))', 'normal'],
      ['n:s2', 'if (!y)', 'normal'],
      ['n:s3', 'y を返す', 'end'],
    ]);
    expect(rows(folded)).toEqual(['n:s0: 成立 → 終わり: `x` を返す (end)', 'n:s2: 成立 → 失敗: `throw invalid()` (error)']);
    expect(arrows(folded)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1i0 (flow)', 'n:s1i0→n:s1 (flow)', 'n:s1→n:s2 (flow)', 'n:s2→n:s3 (flow)']);
    expect(box(folded, 'n:s0').holds).toEqual(['s0', 's0i0', 's0t0']);
    expect(box(folded, 'n:s0').calls).toEqual([fn('isX')]);
    expect(box(folded, 'n:s0').rows[0]?.side).toEqual({ node: 's0', side: 'true' });
    expect(box(folded, 'n:s2').holds).toEqual(['s2', 's2t0', 's2t0i0']);
    expect(box(frameDiagram(checks, '', undefined, { hasFrame }), 'n:s0').opens).toBeUndefined();
  });

  it('should say in full what a side calls before it ends, in words where the JSDoc has them', () => {
    const calling = frameOf([decide('s0', 'if (hashed)', 'guard', [call('s0t0', 'verifyHash', { code: 'await verifyHash(secret)' }), returned('s0t1', 'return')]), call('s1', 'compare')]);
    expect(box(frameDiagram(calling, ''), 'n:s0').rows.map((row) => row.full)).toEqual(['成立 → `await verifyHash(secret)`、終わり: ここで終わる']);
    expect(box(frameDiagram(calling, '', undefined, { words: source }), 'n:s0').rows.map((row) => row.full)).toEqual(['成立 → ハッシュを確かめる、終わり: ここで終わる']);
    const forked = frameOf([decide('s0', 'if (expired)', 'fork', [call('s0t0', 'remove'), thrown('s0t1', 'throw expired()')], [call('s0e0', 'keep')])]);
    expect(box(frameDiagram(forked, ''), 'n:s0').rows.map((row) => [row.full, row.tone])).toEqual([['成立 → `remove()`、失敗: `throw expired()`', 'error']]);
  });

  it('should keep the other side of a guard that a feature forces, and end at a guard whose exit it forces', () => {
    const dispatch = frameOf([decide('s0', 'if (issued)', 'guard', [returned('s0t0', 'return issued')], [], { absent: { feature: 'x', side: 'false' } }), call('s1', 'next')]);
    expect(rows(frameDiagram(dispatch, '', new Set(['x'])))).toEqual(['n:s0: 成立 → 終わり: `issued` を返す (end)']);
    expect(rows(frameDiagram(dispatch, '', new Set()))).toEqual([]);
    expect(arrows(frameDiagram(dispatch, '', new Set()))).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1 (flow)']);
    const required = frameOf([decide('s0', 'if (!ready)', 'guard', [thrown('s0t0', 'throw notReady()')], [], { absent: { feature: 'x', side: 'true' } }), call('s1', 'next')]);
    expect(arrows(frameDiagram(required, '', new Set()))).toEqual(['start→n:s0 (flow)']);
  });

  it('should fold an optional item into one box whose line says what it does', () => {
    const optional = frameDiagram(frameOf([decide('s0', 'if (x)', 'optional', [action('s0t0', 'a.b = x')]), call('s1', 'next')]), '');
    expect([box(optional, 'n:s0').title, box(optional, 'n:s0').code]).toEqual(['if (x) → a.b = x', 'if (x)\n→ a.b = x']);
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
    expect(box(forked, 'n:s0').rows).toEqual([{ full: '成立 → 終わり: `a` を返す', tone: 'end', side: { node: 's0', side: 'true' }, ends: ['s0t0'] }]);
    expect(arrows(forked)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s0e0 不成立 (branch)', 'n:s0e0→n:s1 (flow)']);
  });

  it('should make a case that ends at once a row of its switch and keep the other cases as sides', () => {
    const folded = frameDiagram(mixed, '');
    expect(box(folded, 'n:s3').rows.map((row) => [row.full, row.side])).toEqual([["case 'x' → 終わり: `x` を返す", { node: 's3', side: 'c0' }]]);
    expect(arrows(folded).filter((arrow) => arrow.startsWith('n:s3→'))).toEqual(["n:s3→n:s3c1s0 case 'y' (branch)", 'n:s3→n:s4 default (branch)']);
  });

  it('should make a catch that is one step a row of the region naming the step, and draw the step after the region once it is opened', () => {
    const handler = step('s1h0', 'エラーで応答する', [
      decide('s1h0s0', 'if (error instanceof TokenError)', 'guard', [returned('s1h0s0t0', 'return oauthError(error)', [call('s1h0s0t0i0', 'oauthError')])]),
      returned('s1h0s1', "return oauthError('server_error')", [call('s1h0s1i0', 'oauthError')]),
    ]);
    const catching = frameOf([call('s0', 'load'), attempt('s1', [call('s1b0', 'work')], [handler])]);
    const folded = frameDiagram(catching, '');
    expect(region(folded, 'g:s1').rows).toEqual([{ full: '例外 → エラーで応答する', tone: 'end', side: { node: 's1', side: 'catch' }, ends: ['s1h0s0t0', 's1h0s1'], step: 's1h0' }]);
    expect(region(folded, 'g:s1').holds).toEqual(['s1', 's1h0', 's1h0s0', 's1h0s0t0', 's1h0s0t0i0', 's1h0s1', 's1h0s1i0']);
    expect(lost(catching, folded)).toEqual([]);
    const opened = frameDiagram(catching, '', undefined, { toggled: new Set(['s1h0']) });
    expect(region(opened, 'g:s1').rows).toEqual([]);
    expect(region(opened, 'g:s1').outcome).toBe('例外 → 赤い破線の矢印の先へ進む（エラーで応答する）');
    expect(boxes(opened).slice(3)).toEqual([
      ['n:s1h0', '▾ エラーで応答する', 'normal'],
      ['n:s1h0s0', 'if (error instanceof TokenError)', 'normal'],
      ['n:s1h0s1', "return oauthError('server_error')", 'end'],
    ]);
    expect(arrows(opened).slice(2)).toEqual(['g:s1→n:s1h0 例外が起きたとき (error)', 'n:s1h0→n:s1h0s0 (flow)', 'n:s1h0s0→n:s1h0s1 (flow)']);
    expect(opened.sides.get(2)).toEqual({ node: 's1', side: 'catch' });
    expect(lost(catching, opened)).toEqual([]);
  });

  it('should draw a catch that decides something after its region, entered by a red arrow from the region, and keep a side that holds two steps as a side', () => {
    const deciding = frameOf([attempt('s0', [call('s0b0', 'work')], [decide('s0h0', 'if (error instanceof X)', 'guard', [thrown('s0h0t0', 'throw error', { rethrow: true })]), thrown('s0h1', 'throw wrap(error)')])]);
    const caught = frameDiagram(deciding, '');
    expect(region(caught, 'g:s0').rows).toEqual([]);
    expect(region(caught, 'g:s0').members).toEqual(['n:s0b0']);
    expect(arrows(caught)).toEqual(['start→n:s0b0 (flow)', 'g:s0→n:s0h0 例外が起きたとき (error)', 'n:s0h0→n:s0h1 (flow)']);
    expect([box(caught, 'n:s0h0').group, box(caught, 'n:s0h1').group]).toEqual([undefined, undefined]);
    expect(lost(deciding, caught)).toEqual([]);
    const stepping = frameOf([decide('s0', 'if (x)', 'fork', [step('s0t0', '準備する', [call('s0t0s0', 'a')]), step('s0t1', '答える', [returned('s0t1s0', 'return b')])], [call('s0e0', 'c')])]);
    const drawn = frameDiagram(stepping, '');
    expect(box(drawn, 'n:s0').rows).toEqual([]);
    expect(boxes(drawn).map(([id]) => id)).toEqual(['start', 'n:s0', 'n:s0t0', 'n:s0t1', 'n:s0e0']);
    expect(lost(stepping, drawn)).toEqual([]);
  });

  it('should nest the region of a try inside another, draw a catch that ignores the exception as a row, and draw a try with only a finally as a plain region', () => {
    const drawn = frameDiagram(nested, '');
    expect(drawn.groups.map((group) => [group.id, group.parent ?? '', group.members, group.rows.map((row) => `${row.full} (${row.tone})`)])).toEqual([
      ['g:s0t0', '', ['n:s0t0b0', 'n:s0t0b1b0', 'n:s0t0b1h0', 'n:s0t0b1h1', 'n:s0t0b2'], ['例外 → 失敗: `throw error` (error)']],
      ['g:s0t0b1', 'g:s0t0', ['n:s0t0b1b0'], []],
      ['g:s1', '', ['n:s1b0'], ['例外 → 無視して先へ進む (pass)']],
      ['g:s2', '', ['n:s2b0'], []],
    ]);
    expect(drawn.nodes.map((node) => `${node.id} ${node.group ?? ''}`)).toEqual(['start ', 'n:s0 ', 'n:s0t0b0 g:s0t0', 'n:s0t0b1b0 g:s0t0b1', 'n:s0t0b1h0 g:s0t0', 'n:s0t0b1h1 g:s0t0', 'n:s0t0b2 g:s0t0', 'n:s0e0 ', 'n:s1b0 g:s1', 'n:s2b0 g:s2', 'n:s2f0 ', 'n:s3 ']);
    expect(arrows(drawn)).toEqual([
      'start→n:s0 (flow)',
      'n:s0→n:s0t0b0 成立 (branch)',
      'n:s0t0b0→n:s0t0b1b0 (flow)',
      'g:s0t0b1→n:s0t0b1h0 例外が起きたとき (error)',
      'n:s0t0b1h0→n:s0t0b1h1 (flow)',
      'n:s0t0b1b0→n:s0t0b2 (flow)',
      'n:s0t0b1h1→n:s0t0b2 (flow)',
      'n:s0→n:s0e0 不成立 (branch)',
      'n:s0t0b2→n:s1b0 (flow)',
      'n:s0e0→n:s1b0 (flow)',
      'n:s1b0→n:s2b0 (flow)',
      'n:s2b0→n:s2f0 (flow)',
      'n:s2f0→n:s3 (flow)',
    ]);
    expect([region(drawn, 'g:s1').outcome, region(drawn, 'g:s2').outcome]).toEqual(['例外 → 無視して先へ進む', '例外は捕まえずに、finally のあと呼び出し元へ投げ直す']);
    expect(lost(nested, drawn)).toEqual([]);
  });

  it('should draw a try with nothing in its body as a box of its own, its catch a row of it', () => {
    const empty = frameOf([attempt('s0', [], [thrown('s0h0', 'throw error')]), call('s1', 'next')]);
    const drawn = frameDiagram(empty, '');
    expect(drawn.groups).toEqual([]);
    expect(boxes(drawn)).toEqual([['start', 'f(x)', 'start'], ['n:s0', 'ここから例外を捕まえる', 'normal'], ['n:s1', 'next()', 'normal']]);
    expect(rows(drawn)).toEqual(['n:s0: 例外 → 失敗: `throw error` (error)']);
    expect(lost(empty, drawn)).toEqual([]);
  });

  it('should fold a loop of one call into one box whose line says what it repeats and draw a loop with a guard inside in full', () => {
    const loops = frameDiagram(frameOf([loop('s0', 'for (const x of xs)', [call('s0l0', 'each')]), loop('s1', 'for (const y of ys)', [decide('s1l0', 'if (!y)', 'guard', [thrown('s1l0t0', 'throw missing()')]), call('s1l1', 'h')]), returned('s2', 'return done')]), '');
    expect(boxes(loops)).toEqual([
      ['start', 'f(x)', 'start'],
      ['n:s0', 'for (const x of xs) → each()', 'normal'],
      ['n:s1', 'for (const y of ys)', 'normal'],
      ['n:s1l0', 'if (!y)', 'normal'],
      ['n:s1l1', 'h()', 'normal'],
      ['n:s2', 'done を返す', 'end'],
    ]);
    expect([box(loops, 'n:s0').code, box(loops, 'n:s0').holds]).toEqual(['for (const x of xs)\neach()', ['s0', 's0l0']]);
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
    const twice = frameOf([returned('s0', 'return p() && !q() && r()', [outer])]);
    const drawn = frameDiagram(twice, '');
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
    expect(lost(twice, drawn)).toEqual([]);
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
      'n:s0t0 a を返す',
      'n:s1 if (!b)',
      'n:s1t0 b を返す',
      'n:s2 if (c)',
      'n:s2t0 c を返す',
      'n:s2e0 d()',
      'n:s3 const e = 1',
      'n:s4 const f = 2',
      'n:s5 g、h を用意する',
      'n:s7i0 wrap()',
      'n:s7 h を返す',
    ]);
    expect(rows(drawn)).toEqual([]);
    expect(drawn.nodes.map((node) => markOfBox(node, change, undefined)?.label ?? '')).toEqual(['', '変更', '', '', '追加', '', '変更', '', '', '追加', '', '変更', '']);
    const unmarked = frameDiagram(reviewed, '');
    expect(boxes(unmarked).map(([id, title]) => `${id} ${title}`)).toEqual(['start f(x)', 'n:s0 if (!a)', 'n:s1 if (!b)', 'n:s2 if (c)', 'n:s2e0 d()', 'n:s3 e、f、g、h を用意する', 'n:s7 h を返す']);
    expect(rows(unmarked)).toEqual(['n:s0: 成立 → 終わり: `a` を返す (end)', 'n:s1: 成立 → 終わり: `b` を返す (end)', 'n:s2: 成立 → 終わり: `c` を返す (end)']);
  });

  it('should draw a changed loop, and a loop whose body changed, in full', () => {
    const loops = frameOf([loop('s0', 'for (const x of xs)', [call('s0l0', 'each')]), loop('s1', 'for (const y of ys)', [call('s1l0', 'each')]), loop('s2', 'for (const z of zs)', [call('s2l0', 'each')])]);
    const marked = new Set(['s0', 's1l0']);
    const drawn = frameDiagram(loops, '', undefined, { changed: (id) => marked.has(id) });
    expect(boxes(drawn).map(([id]) => id)).toEqual(['start', 'n:s0', 'n:s0l0', 'n:s1', 'n:s1l0', 'n:s2']);
    expect(box(drawn, 'n:s2').holds).toEqual(['s2', 's2l0']);
  });

  it('should show every decision and every exit of a frame as a box, a region, a row or inside a folded step', () => {
    expect(lost(tree, diagram)).toEqual([]);
    expect(lost(checks, frameDiagram(checks, ''))).toEqual([]);
    expect(lost(mixed, frameDiagram(mixed, ''))).toEqual([]);
    expect(lost(nested, frameDiagram(nested, ''))).toEqual([]);
    expect(lost(mixed, { ...frameDiagram(mixed, ''), nodes: [], groups: [] })).toEqual(['s0', 's0t0', 's1', 's2', 's2t0', 's3', 's3c0s0', 's4', 's4l0', 's4l0t0', 's5', 's5b0s1', 's5b0s1t0', 's5h0', 's6']);
  });
});

describe('activeOf', () => {
  const diagram = frameDiagram(tree, '');
  const edge = (index: number) => diagram.edges[index];

  it('should take the boxes, regions and arrows a choice runs through, leaving out the arrows of the sides it does not take', () => {
    const active = activeOf(diagram, tree, '', [{ s2: 'false', s3: 'try' }]);
    expect([...active.nodes].sort()).toEqual(['n:s0', 'n:s2', 'n:s3b0', 'n:s4', 'start']);
    expect([...active.groups]).toEqual(['g:s3']);
    expect([...active.edges].map((index) => `${edge(index)?.from}→${edge(index)?.to}`)).toEqual(['start→n:s0', 'n:s0→n:s2', 'n:s2→n:s3b0', 'n:s3b0→n:s4']);
    expect([...active.rows]).toEqual([]);
    expect([...activeOf(diagram, tree, '', [{ s3: 'catch' }]).rows]).toEqual(['g:s3|0']);
  });

  it('should take everything when nothing is chosen, every row of the boxes and the regions included', () => {
    const active = activeOf(diagram, tree, '', []);
    expect(active.nodes.size).toBe(diagram.nodes.length);
    expect(active.edges.size).toBe(diagram.edges.length);
    expect([...active.groups]).toEqual(['g:s3']);
    expect([...activeOf(frameDiagram(mixed, ''), mixed, '', []).rows]).toEqual(['n:s0|0', 'n:s2|0', 'n:s3|0', 'n:s4l0|0', 'n:s5b0|0', 'g:s5|0']);
  });

  it('should turn off the row of a guard whose other side is chosen, and turn it on and what follows off when its side is', () => {
    const folded = frameDiagram(checks, '');
    const passed = activeOf(folded, checks, '', [{ s2: 'false' }]);
    expect([passed.rows.has('n:s2|0'), passed.nodes.has('n:s2'), passed.nodes.has('n:s3')]).toEqual([false, true, true]);
    const throwing = activeOf(folded, checks, '', [{ s2: 'true' }]);
    expect([throwing.rows.has('n:s2|0'), throwing.nodes.has('n:s2'), throwing.nodes.has('n:s3')]).toEqual([true, true, false]);
    expect([...throwing.edges].map((index) => folded.edges[index]?.to)).toEqual(['n:s0', 'n:s1i0', 'n:s1', 'n:s2']);
  });

  it('should run the red arrow out of a region and the boxes of its catch when the catch is chosen, and turn on the row of a catch that ignores the exception', () => {
    const drawn = frameDiagram(nested, '');
    const index = drawn.edges.findIndex((arrow) => arrow.from === 'g:s0t0b1');
    const catching = activeOf(drawn, nested, '', [{ s0t0b1: 'catch' }]);
    const passing = activeOf(drawn, nested, '', [{ s0t0b1: 'try' }]);
    expect([catching.edges.has(index), catching.nodes.has('n:s0t0b1h0'), catching.nodes.has('n:s0t0b1b0'), catching.groups.has('g:s0t0b1')]).toEqual([true, true, false, true]);
    expect([passing.edges.has(index), passing.nodes.has('n:s0t0b1h0'), passing.nodes.has('n:s0t0b1b0')]).toEqual([false, false, true]);
    expect([activeOf(drawn, nested, '', []).rows.has('g:s1|0'), activeOf(drawn, nested, '', [{ s1: 'catch' }]).rows.has('g:s1|0'), activeOf(drawn, nested, '', [{ s1: 'try' }]).rows.has('g:s1|0')]).toEqual([true, true, false]);
    expect(activeOf(drawn, nested, '', [{ s0: 'false' }]).groups.has('g:s0t0')).toBe(false);
  });

  it('should place every box and region the same for no choice and for each side of each decision', () => {
    const folded = frameDiagram(mixed, '');
    const choices = everySide(mixed);
    expect(choices.length).toBe(17);
    expect(new Set(choices.map((choice) => [...activeOf(folded, mixed, '', choice).edges].join())).size).toBeGreaterThan(1);
    expect(choices.map((choice) => placed(folded, mixed, choice, 'TB'))).toEqual(choices.map(() => placed(folded, mixed, [], 'TB')));
    expect(choices.map((choice) => placed(folded, mixed, choice, 'LR'))).toEqual(choices.map(() => placed(folded, mixed, [], 'LR')));
    expect(placed(folded, mixed, [], 'TB').boxWidth).toBe(200);
  });

  it('should place every box and region of nested tries the same for no choice and for each side of each decision', () => {
    const drawn = frameDiagram(nested, '');
    const choices = everySide(nested);
    expect(choices.length).toBe(8);
    expect(choices.map((choice) => placed(drawn, nested, choice, 'TB'))).toEqual(choices.map(() => placed(drawn, nested, [], 'TB')));
    expect(choices.map((choice) => placed(drawn, nested, choice, 'LR'))).toEqual(choices.map(() => placed(drawn, nested, [], 'LR')));
  });
});

describe('layoutDiagram', () => {
  it.each(['TB', 'LR'] as const)('should enclose the boxes of each region and the regions inside it, with the room of its label at the top, and keep every other box outside it in %s', (direction) => {
    const drawn = frameDiagram(nested, '');
    const layout = layoutDiagram(drawn, new Set(drawn.edges.map((_, index) => index)), direction);
    const rect = (id: string) => [...layout.boxes, ...layout.groups].find((candidate) => candidate.id === id) as LayoutBox;
    const enclosed = drawn.groups.flatMap((group) => group.members.map((member) => encloses(rect(group.id), rect(member), 8)));
    const nestedIn = drawn.groups.flatMap((group) => (group.parent === undefined ? [] : [encloses(rect(group.parent), rect(group.id), 8)]));
    const outside = drawn.groups.flatMap((group) => drawn.nodes.filter((node) => !group.members.includes(node.id)).filter((node) => overlaps(rect(group.id), rect(node.id))).map((node) => `${group.id} ${node.id}`));
    const header = drawn.groups.map((group) => Math.min(...[...group.members.map((member) => rect(member).y), ...drawn.groups.filter((inner) => inner.parent === group.id).map((inner) => rect(inner.id).y)]) - rect(group.id).y);
    expect(layout.groups.map((group) => group.id)).toEqual(['g:s0t0', 'g:s0t0b1', 'g:s1', 'g:s2']);
    expect(enclosed.every((inside) => inside)).toBe(true);
    expect(nestedIn).toEqual([true]);
    expect(outside).toEqual([]);
    expect(header.every((room) => room >= REGION_HEADER)).toBe(true);
    expect(layout.boxes.every((placedBox) => placedBox.height === boxHeight())).toBe(true);
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

  it('should draw one box a step inside the region of the try, the catch a row of the region, and no arrow out of the step that ends', () => {
    expect(boxes(diagram)).toEqual([
      ['start', 'POST /token', 'start'],
      ['n:s0b0', 'リクエストを解析する', 'normal'],
      ['n:s0b1', 'トークン交換', 'normal'],
      ['n:s0b2', '▸ 認可コードを検証する', 'normal'],
      ['n:s0b3', '応答する', 'normal'],
    ]);
    expect(rows(diagram)).toEqual(['n:s0b1: → 終わり: `exchanged` を返す (end)', 'n:s0b3: → 終わり: `return respond(c)` (end)', 'g:s0: 例外 → 終わり: `return respondError(c, error)` (end)']);
    expect(arrows(diagram)).toEqual(['start→n:s0b0 (flow)', 'n:s0b0→n:s0b1 (flow)', 'n:s0b1→n:s0b2 (flow)', 'n:s0b2→n:s0b3 (flow)']);
    expect(region(diagram, 'g:s0').members).toEqual(['n:s0b0', 'n:s0b1', 'n:s0b2', 'n:s0b3']);
    expect(box(diagram, 'n:s0b2').holds).toEqual(['s0b2', 's0b2s0', 's0b2s0n0']);
    expect(box(diagram, 'n:s0b1').calls).toEqual([fn('exchange')]);
    expect(box(diagram, 'n:s0b0').code).toBe('const params = await parse(c)');
    expect(box(diagram, 'n:s0b2').code).toBe('const request = refresh ?? (await code())');
    expect(lost(token, diagram)).toEqual([]);
  });

  it('should let the card of a step of one call open the frame of that call, and the card of any other step toggle it', () => {
    expect(box(diagram, 'n:s0b0').opens).toEqual({ node: 's0b0s0', fn: fn('parse') });
    expect(box(diagram, 'n:s0b1').opens).toEqual({ node: 's0b1s0', fn: fn('exchange') });
    expect(box(diagram, 'n:s0b3').opens).toEqual({ node: 's0b3s0i0', fn: fn('respond') });
    expect(box(diagram, 'n:s0b2').opens).toBeUndefined();
    expect(box(diagram, 'n:s0b2').step).toEqual({ id: 's0b2', open: false, toggles: true });
    expect(box(diagram, 'n:s0b0').step).toEqual({ id: 's0b0', open: false, toggles: false });
    expect(boxActions(box(diagram, 'n:s0b2'))).toEqual([{ kind: 'toggle', step: 's0b2', open: false }]);
  });

  it('should let a step whose only call is on the way out of its guard toggle, and a step whose call is the condition of its guard open it', () => {
    const exiting = frameOf([step('s0', '明示的な承認を求める', [decide('s0s0', "if (action !== 'approve')", 'guard', [returned('s0s0t0', 'return redirectToErrorPage(…)', [call('s0s0t0i0', 'redirectToErrorPage')])])]), call('s1', 'approve')]);
    const exit = box(frameDiagram(exiting, '', undefined, { hasFrame }), 'n:s0');
    expect([exit.title, exit.opens, boxActions(exit).map((action) => action.kind), exit.rows.map((row) => row.full)]).toEqual(['▸ 明示的な承認を求める', undefined, ['toggle'], ['→ 終わり: `return redirectToErrorPage(…)`']]);
    const checking = frameOf([step('s0', '確かめる', [decide('s0s0', 'if (!(await verify(x)))', 'guard', [returned('s0s0t0', 'return null')], [], { pre: [call('s0s0i0', 'verify')] })])]);
    const check = box(frameDiagram(checking, '', undefined, { hasFrame }), 'n:s0');
    expect([check.title, check.opens, boxActions(check)]).toEqual(['確かめる', { node: 's0s0i0', fn: fn('verify') }, [{ kind: 'open', node: 's0s0i0', fn: fn('verify'), name: 'verify()' }]]);
  });

  it('should let a step that calls a member besides its function toggle, not open the function', () => {
    const issue: TreeNode = { id: 's0s1', kind: 'call', lines: [3, 3], code: 'await issuer.issue(payload)', target: { kind: 'member', id: 'core:issuer.ts#Issuer.issue' } };
    const issuing = frameDiagram(frameOf([step('s0', 'アクセストークンを発行する', [call('s0s0', 'build'), issue])]), '', undefined, { hasFrame });
    expect([box(issuing, 'n:s0').title, box(issuing, 'n:s0').opens, box(issuing, 'n:s0').calls, box(issuing, 'n:s0').code]).toEqual(['▸ アクセストークンを発行する', undefined, [fn('build')], 'build()\nawait issuer.issue(payload)']);
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
    expect(rows(frameDiagram(switched, ''))).toEqual(['n:s0: → 終わり: `return a()` (end)', 'n:s0: → 失敗: `throw unknown()` (error)']);
  });

  it('should draw a step the reader opens as its heading and its body, and fold it back when it is toggled again', () => {
    const opened = frameDiagram(token, '', undefined, { hasFrame, toggled: new Set(['s0b2']) });
    expect(boxes(opened).slice(3, 6)).toEqual([
      ['n:s0b2', '▾ 認可コードを検証する', 'normal'],
      ['n:s0b2s0', 'const request = refresh ?? (await code())', 'normal'],
      ['n:s0b2s0n0', 'code()', 'normal'],
    ]);
    expect([box(opened, 'n:s0b2').code, box(opened, 'n:s0b2').holds, box(opened, 'n:s0b2').step]).toEqual(['', ['s0b2'], { id: 's0b2', open: true, toggles: true }]);
    expect(boxActions(box(opened, 'n:s0b2'))).toEqual([{ kind: 'toggle', step: 's0b2', open: true }]);
    expect(arrows(opened).slice(2)).toEqual(['n:s0b1→n:s0b2 (flow)', 'n:s0b2→n:s0b2s0 (flow)', 'n:s0b2s0→n:s0b2s0n0 null または undefined (branch)', 'n:s0b2s0→n:s0b3 値あり (branch)', 'n:s0b2s0n0→n:s0b3 (flow)']);
    expect(region(opened, 'g:s0').members).toEqual(['n:s0b0', 'n:s0b1', 'n:s0b2', 'n:s0b2s0', 'n:s0b2s0n0', 'n:s0b3']);
    expect(lost(token, opened)).toEqual([]);
    expect(frameDiagram(token, '', undefined, { hasFrame, toggled: new Set() })).toEqual(diagram);
  });

  it('should open a step that holds a changed node, its badge on the node, and let a toggle fold it to a box that toggles with the badge', () => {
    const change: FrameChange = { kind: 'modified', marks: { s0b1s1: 'modified' }, removed: [], exprs: {}, hunks: {}, summary: [] };
    const changed = (id: string) => change.marks[id] !== undefined;
    const opened = frameDiagram(token, '', undefined, { hasFrame, changed });
    expect(boxes(opened).slice(2, 6).map(([id, title]) => `${id} ${title}`)).toEqual(['n:s0b1 ▾ トークン交換', 'n:s0b1s0 exchange()', 'n:s0b1s1 if (exchanged)', 'n:s0b1s1t0 exchanged を返す']);
    expect(opened.nodes.slice(2, 6).map((node) => markOfBox(node, change, undefined)?.label ?? '')).toEqual(['', '', '変更', '']);
    expect(['n:s0b0', 'n:s0b2', 'n:s0b3'].map((id) => box(opened, id).step?.open)).toEqual([false, false, false]);
    expect(lost(token, opened)).toEqual([]);
    const folded = frameDiagram(token, '', undefined, { hasFrame, changed, toggled: new Set(['s0b1']) });
    expect([box(folded, 'n:s0b1').title, box(folded, 'n:s0b1').opens, boxActions(box(folded, 'n:s0b1')).map((action) => action.kind)]).toEqual(['▸ トークン交換', undefined, ['toggle']]);
    expect(markOfBox(box(folded, 'n:s0b1'), change, undefined)?.label).toBe('変更');
    expect(lost(token, folded)).toEqual([]);
    const callChanged = frameDiagram(token, '', undefined, { hasFrame, changed: (id) => id === 's0b1s0', toggled: new Set(['s0b1']) });
    expect([box(callChanged, 'n:s0b1').title, box(callChanged, 'n:s0b1').opens]).toEqual(['▸ トークン交換', undefined]);
  });

  it('should give a folded step a row for its returns and one for its throws, each exit in words, ×n for several that read the same', () => {
    const oauthError = (id: string, code: string) => returned(id, code, [call(`${id}i0`, 'oauthError', { code: code.replace('return ', '') })]);
    const parse = frameOf([
      step('s0', 'リクエストを解析する', [
        decide('s0s0', 'if (!isForm(request))', 'guard', [oauthError('s0s0t0', 'return oauthError(…)')], [], { pre: [call('s0s0i0', 'isForm')] }),
        decide('s0s1', 'if (duplicate)', 'guard', [oauthError('s0s1t0', "return oauthError('invalid_request', `…`)")]),
        decide('s0s2', 'if (!valid)', 'guard', [oauthError('s0s2t0', "return oauthError('invalid_grant')")]),
        action('s0s3', 'const params = raw'),
      ]),
      step('s1', '確かめる', [decide('s1s0', 'if (!a)', 'guard', [returned('s1s0t0', 'return a')]), decide('s1s1', 'if (!b)', 'guard', [thrown('s1s1t0', 'throw b()')])]),
      step('s2', '拒む', [decide('s2s0', 'if (!a)', 'guard', [thrown('s2s0t0', 'throw a()', { error: 'A' })]), decide('s2s1', 'if (!b)', 'guard', [thrown('s2s1t0', 'throw a()', { error: 'A' })])]),
    ]);
    const words = { functions: { [fn('oauthError')]: { summary: 'OAuth のエラーを返す。' } }, members: {} } as unknown as WordSource;
    const steps = frameDiagram(parse, '', undefined, { hasFrame, words });
    expect(steps.nodes.map((node) => node.rows)).toEqual([
      [],
      [{ full: '→ 終わり: OAuth のエラーを返す ×3', tone: 'end', ends: ['s0s0t0', 's0s1t0', 's0s2t0'] }],
      [{ full: '→ 終わり: `a` を返す', tone: 'end', ends: ['s1s0t0'] }, { full: '→ 失敗: `throw b()`', tone: 'error', ends: ['s1s1t0'] }],
      [{ full: '→ 失敗: `A` を投げる ×2', tone: 'error', ends: ['s2s0t0', 's2s1t0'] }],
    ]);
    expect(box(steps, 'n:s0').title).toBe('▸ リクエストを解析する');
    expect(arrows(steps)).toEqual(['start→n:s0 (flow)', 'n:s0→n:s1 (flow)', 'n:s1→n:s2 (flow)']);
  });

  it('should offer on a card what its box can do besides selecting: open the frame of its call, toggle its step, open the step a row names', () => {
    const opened = frameDiagram(token, '', undefined, { hasFrame, toggled: new Set(['s0b2']) });
    const handler = step('s1h0', 'エラーで応答する', [returned('s1h0s0', 'return respondError(c)', [call('s1h0s0i0', 'respondError')])]);
    const catching = frameDiagram(frameOf([attempt('s1', [call('s1b0', 'work')], [handler])]), '', undefined, { hasFrame });
    expect([boxActions(box(diagram, 'start')), boxActions(box(diagram, 'n:s0b0')), boxActions(box(opened, 'n:s0b2s0')), boxActions(box(opened, 'n:s0b2s0n0'))]).toEqual([
      [],
      [{ kind: 'open', node: 's0b0s0', fn: fn('parse'), name: 'parse()' }],
      [],
      [{ kind: 'open', node: 's0b2s0n0', fn: fn('code'), name: 'code()' }],
    ]);
    expect(boxActions(region(catching, 'g:s1'))).toEqual([{ kind: 'toggle', step: 's1h0', open: false, row: 0 }]);
    expect(boxActions(box(frameDiagram(token, '', undefined, { toggled: new Set(['s0b2']) }), 'n:s0b0'))).toEqual([{ kind: 'toggle', step: 's0b0', open: false }]);
  });
});

describe('boxOf', () => {
  it('should find the box that holds a node, else the region of its try, else the box of its nearest ancestor', () => {
    const folded = frameDiagram(checks, '');
    expect(boxOf(folded, 's0t0')?.id).toBe('n:s0');
    expect(boxOf(folded, 's0i0')?.id).toBe('n:s0');
    expect(boxOf(folded, 's1i0')?.id).toBe('n:s1i0');
    expect(boxOf(folded, 's2t0i0')?.id).toBe('n:s2');
    expect(boxOf(folded, 's9')).toBeUndefined();
    const steps = frameDiagram(token, '');
    expect(boxOf(steps, 's0b2s0n0')?.id).toBe('n:s0b2');
    expect(boxOf(steps, 's0')?.id).toBe('g:s0');
    expect(boxOf(steps, 's0h0i0')?.id).toBe('g:s0');
    expect(boxOf(steps, 's0b1s1t0')?.id).toBe('n:s0b1');
    expect(boxOf(frameDiagram(tree, '', new Set()), 's1')?.id).toBe('n:s0');
    expect(boxOf(frameDiagram(token, '', undefined, { toggled: new Set(['s0b2']) }), 's0b2s0n0s1')?.id).toBe('n:s0b2s0n0');
    expect([isRegion(boxOf(steps, 's0') as DiagramGroup), isRegion(boxOf(steps, 's0b0') as DiagramNode)]).toEqual([true, false]);
  });
});

describe('the line of a box', () => {
  const sized = (title: string, tone: DiagramNode['tone'] = 'normal', rowTones: Array<'end' | 'error'> = [], titleCode = false): DiagramNode => ({
    id: 'n:s0',
    node: 's0',
    title,
    titleCode,
    code: title,
    tone,
    rows: rowTones.map((tone, index) => ({ full: '→ 終わり: x', tone, ends: [`s0t${index}`] })),
    holds: ['s0'],
    calls: [],
  });

  it('should make every box one line of the same height', () => {
    expect(boxHeight()).toBe(34);
  });

  it('should tag how a box ends at the end of its line: its own exit, then its rows, ×n for several', () => {
    expect(exitTags(sized('return x', 'end')).map((tag) => tag.text)).toEqual(['→ 終わり']);
    expect(exitTags(sized('throw x', 'error')).map((tag) => tag.text)).toEqual(['→ 失敗']);
    expect(exitTags(sized('switch (kind)', 'normal', ['end', 'error', 'end'])).map((tag) => [tag.text, tag.tone, tag.rows])).toEqual([['→ 終わり ×2', 'end', [0, 2]], ['→ 失敗', 'error', [1]]]);
    expect(exitTags(sized('f()'))).toEqual([]);
    expect(exitTags({ ...sized('f(x)', 'start') })).toEqual([]);
  });

  it('should cut a title too long for its room with an ellipsis, the room its tags and its badge leave it', () => {
    const long = 'クライアントを認証し、認証したクライアントを返す';
    expect(boxLine(sized('クライアントを認証する'), 320)).toEqual({ title: 'クライアントを認証する', cut: false, room: 296, tags: [] });
    expect([boxLine(sized(long), 320).title, boxLine(sized(long), 320).cut]).toEqual(['クライアントを認証し、認証したクライアントを返…', true]);
    expect(boxLine(sized(long), 200).title).toBe('クライアントを認証し、認証…');
    expect([boxLine(sized(long, 'normal', ['end']), 320).title, boxLine(sized(long, 'normal', ['end']), 320).room]).toEqual(['クライアントを認証し、認証したクライ…', 238]);
    expect(boxLine(sized(long), 320, 100).title).toBe('クライアントを認証し、認証した…');
    expect(boxLine(sized('const parameters = await parseTokenRequest(c)', 'normal', [], true), 200).title).toBe('const parameters = awai…');
  });

  it('should label a region by what it does with an exception, red where it fails', () => {
    const drawn = frameDiagram(nested, '');
    expect(drawn.groups.map((group) => regionTags(group).map((tag) => `${tag.text} (${tag.tone})`))).toEqual([['→ 例外: 失敗 (error)'], [], ['→ 例外は無視して先へ (pass)'], []]);
    expect(regionTags(region(frameDiagram(token, ''), 'g:s0')).map((tag) => tag.text)).toEqual(['→ 例外: 終わり']);
    expect(regionLine(region(drawn, 'g:s1'), 240)).toEqual({ title: '例外を捕まえる範囲', cut: false, room: 102, tags: regionTags(region(drawn, 'g:s1')) });
    expect(regionLine(region(drawn, 'g:s1'), 200).title).toBe('例外を捕ま…');
  });
});

describe('spokenLabel', () => {
  it('should join the lines of a label with 。 and keep a single full stop after a line that ends with one', () => {
    expect(spokenLabel(['loadSigningKeys()', '用途ごとの署名鍵の集合を読み込み、検証して返す。', '押すとアウトラインの行を選ぶ'])).toBe('loadSigningKeys()。用途ごとの署名鍵の集合を読み込み、検証して返す。押すとアウトラインの行を選ぶ');
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
  const change: FrameChange = { kind: 'modified', marks: { s0s1: 'modified', s4: 'added' }, removed: [], exprs: {}, hunks: {}, summary: [] };
  const folded = frameDiagram(frameOf([step('s0', '準備する', [call('s0s0', 'top'), action('s0s1', 'const a = 1')]), call('s1', 'top'), call('s2', 'leaf'), action('s3', 'const b = 2'), attempt('s4', [call('s4b0', 'top')], [returned('s4h0', 'return leaf()', [call('s4h0i0', 'leaf')])])]), '', undefined, { changed: (id) => change.marks[id] !== undefined, toggled: new Set(['s0']) });

  it('should take the strongest of the badges of the nodes a box or a region holds and of the frames its calls lead to', () => {
    expect(markOfBox(box(folded, 'n:s0'), change, changes)?.kind).toBe('line');
    expect(markOfBox(box(folded, 'n:s0'), change, changes)?.label).toBe('変更');
    expect(markOfBox(box(folded, 'n:s1'), change, changes)?.label).toBe('下で変更');
    expect(markOfBox(box(folded, 'n:s2'), change, changes)?.kind).toBe('modified');
    expect(markOfBox(box(folded, 'n:s3'), change, changes)).toBeUndefined();
    expect(markOfBox(box(folded, 'start'), change, changes)).toBeUndefined();
    expect(markOfBox(box(folded, 'n:s1'), undefined, undefined)).toBeUndefined();
    expect(markOfBox(region(folded, 'g:s4'), change, changes)?.label).toBe('追加');
    expect(region(folded, 'g:s4').calls).toEqual([fn('leaf')]);
  });
});
