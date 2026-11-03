import { describe, expect, it } from 'vitest';
import { activeOf, defaultChecked, deriveCases, ERROR_CASE, layoutGraph, MAIN_CASE, textColumns, truncateColumns, type GraphEdge, type GraphNode } from './graph';

const nodes = (...ids: string[]): GraphNode[] => ids.map((id) => ({ id }));
const label = (id: string) => id.toUpperCase();
const endpointOptions = { errors: 'modifier' as const, nodeLabel: label, nameBySink: false };

/** A token endpoint in small: two grants after a fork, a dispatch that answers itself, and an error step. */
const tokenNodes = nodes('parse', 'dispatch', 'grant', 'code', 'refresh', 'issue', 'respond', 'error');
const tokenEdges: GraphEdge[] = [
  { from: 'parse', to: 'dispatch', kind: 'flow' },
  { from: 'dispatch', to: 'grant', kind: 'flow' },
  { from: 'grant', to: 'code', kind: 'branch', label: 'authorization_code' },
  { from: 'code', to: 'issue', kind: 'flow' },
  { from: 'grant', to: 'refresh', kind: 'branch', label: 'refresh_token' },
  { from: 'refresh', to: 'issue', kind: 'flow' },
  { from: 'issue', to: 'respond', kind: 'flow' },
  { from: 'dispatch', to: 'respond', kind: 'branch', label: 'answered' },
  { from: 'parse', to: 'error', kind: 'error' },
  { from: 'code', to: 'error', kind: 'error' },
  { from: 'refresh', to: 'error', kind: 'error' },
];

describe('deriveCases', () => {
  it('should keep different exits selectable separately even when their displayed return or error labels match', () => {
    const edges: GraphEdge[] = [{ from: 's', to: 'a', kind: 'branch' }, { from: 's', to: 'b', kind: 'branch' }];
    const cases = deriveCases(nodes('s', 'a', 'b'), edges, { errors: 'path', nodeLabel: () => 'same response', nameBySink: true, maxPaths: 1 });
    expect(cases.map((flowCase) => flowCase.label)).toEqual(['→ same response', '→ same response (2)']);
  });

  it('should make a case of each path, named by its labels, and one for the error arrows', () => {
    const cases = deriveCases(tokenNodes, tokenEdges, endpointOptions);
    expect(cases.map((flowCase) => [flowCase.label, flowCase.kind, flowCase.nodes])).toEqual([
      ['authorization_code', 'path', ['parse', 'dispatch', 'grant', 'code', 'issue', 'respond']],
      ['refresh_token', 'path', ['parse', 'dispatch', 'grant', 'refresh', 'issue', 'respond']],
      ['answered', 'path', ['parse', 'dispatch', 'respond']],
      [ERROR_CASE, 'error', []],
    ]);
  });

  it('should name the only path without a label as the main flow', () => {
    const cases = deriveCases(nodes('a', 'b'), [{ from: 'a', to: 'b', kind: 'flow' }], endpointOptions);
    expect(cases.map((flowCase) => flowCase.label)).toEqual([MAIN_CASE]);
  });

  it('should tell apart paths whose labels match by the box their last label leaves', () => {
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b', kind: 'flow' },
      { from: 'a', to: 'end', kind: 'branch', label: 'answered' },
      { from: 'b', to: 'c', kind: 'flow' },
      { from: 'b', to: 'end', kind: 'branch', label: 'answered' },
      { from: 'c', to: 'end', kind: 'flow' },
    ];
    expect(deriveCases(nodes('a', 'b', 'c', 'end'), edges, endpointOptions).map((flowCase) => flowCase.label)).toEqual([MAIN_CASE, 'B: answered', 'A: answered']);
  });

  it('should start a path of a screen at each method and keep it on that method', () => {
    const edges: GraphEdge[] = [
      { from: 'load', to: 'show', kind: 'flow', label: 'GET' },
      { from: 'reject-cross-origin', to: 'load', kind: 'flow', label: 'POST' },
      { from: 'load', to: 'check', kind: 'flow', label: 'POST' },
      { from: 'check', to: 'session', kind: 'branch', label: 'authenticated' },
    ];
    const cases = deriveCases(nodes('load', 'show', 'reject-cross-origin', 'check', 'session'), edges, endpointOptions);
    expect(cases.map((flowCase) => [flowCase.label, flowCase.nodes])).toEqual([
      ['GET', ['load', 'show']],
      ['POST › authenticated', ['reject-cross-origin', 'load', 'check', 'session']],
    ]);
  });

  it('should follow the arrows into a catch block of a function and name each case by where it ends', () => {
    const edges: GraphEdge[] = [
      { from: 'start', to: 'run', kind: 'flow' },
      { from: 'run', to: 'ok', kind: 'flow' },
      { from: 'start', to: 'handle', kind: 'error', label: 'catch' },
      { from: 'handle', to: 'failed', kind: 'flow' },
    ];
    const cases = deriveCases(nodes('start', 'run', 'ok', 'handle', 'failed'), edges, { errors: 'path', nodeLabel: label, nameBySink: true });
    expect(cases.map((flowCase) => flowCase.label)).toEqual(['→ OK', 'catch → FAILED']);
  });

  it('should fall back to one case per box the diagram ends at when there are too many paths', () => {
    const edges: GraphEdge[] = [
      { from: 's', to: 'a', kind: 'branch', label: 'x' },
      { from: 's', to: 'b', kind: 'flow' },
      { from: 'a', to: 'b', kind: 'flow' },
      { from: 'b', to: 'c', kind: 'branch', label: 'y' },
      { from: 'b', to: 'd', kind: 'flow' },
      { from: 'c', to: 'd', kind: 'flow' },
      { from: 'b', to: 'fail', kind: 'branch', label: 'z' },
    ];
    const cases = deriveCases(nodes('s', 'a', 'b', 'c', 'd', 'fail'), edges, { errors: 'path', nodeLabel: label, nameBySink: true, maxPaths: 3 });
    expect(cases.map((flowCase) => [flowCase.kind, flowCase.label, flowCase.nodes])).toEqual([
      ['exit', '→ D', ['s', 'a', 'b', 'c', 'd']],
      ['exit', '→ FAIL', ['s', 'a', 'b', 'fail']],
    ]);
  });
});

describe('defaultChecked', () => {
  it('should check the first case only', () => {
    expect([...defaultChecked(deriveCases(tokenNodes, tokenEdges, endpointOptions))]).toEqual(['c0']);
  });
});

describe('activeOf', () => {
  const cases = deriveCases(tokenNodes, tokenEdges, endpointOptions);

  it('should use the boxes and arrows of the checked cases only', () => {
    const active = activeOf(cases, new Set(['c2']), tokenEdges);
    expect([...active.nodes]).toEqual(['parse', 'dispatch', 'respond']);
    expect([...active.edges]).toEqual([0, 7]);
  });

  it('should add the error arrows from the boxes of the checked cases when the error case is checked', () => {
    const active = activeOf(cases, new Set(['c0', 'error']), tokenEdges);
    expect([...active.edges].filter((index) => tokenEdges[index]!.kind === 'error')).toEqual([8, 9]);
    expect(active.nodes.has('error')).toBe(true);
    expect(active.nodes.has('refresh')).toBe(false);
  });

  it('should show every error arrow when the error case is checked alone', () => {
    const active = activeOf(cases, new Set(['error']), tokenEdges);
    expect([...active.edges]).toEqual([8, 9, 10]);
    expect([...active.nodes]).toEqual(['parse', 'error', 'code', 'refresh']);
  });

  it('should use nothing when no case is checked', () => {
    expect(activeOf(cases, new Set(), tokenEdges)).toEqual({ nodes: new Set(), edges: new Set() });
  });
});

describe('layoutGraph', () => {
  const forkNodes = nodes('start', 'left', 'right', 'join');
  const forkEdges: GraphEdge[] = [
    { from: 'start', to: 'left', kind: 'branch', label: 'yes' },
    { from: 'start', to: 'right', kind: 'branch', label: 'no' },
    { from: 'left', to: 'join', kind: 'flow' },
    { from: 'right', to: 'join', kind: 'flow' },
  ];

  it('should place sibling branches side by side before their shared continuation', () => {
    const layout = layoutGraph(forkNodes, forkEdges, new Set([0, 1, 2, 3]));
    const [start, left, right, join] = layout.boxes;
    expect(left!.y).toBe(right!.y);
    expect(left!.x + left!.width <= right!.x || right!.x + right!.width <= left!.x).toBe(true);
    expect(start!.y + start!.height < left!.y).toBe(true);
    expect(left!.y + left!.height < join!.y).toBe(true);
    expect(layout.arrows.map((arrow) => arrow.label?.text)).toEqual(['yes', 'no', undefined, undefined]);
  });

  it('should keep positions and dimensions stable when cases change and draw only the requested arrows', () => {
    const first = layoutGraph(tokenNodes, tokenEdges, new Set([0, 7]));
    const all = layoutGraph(tokenNodes, tokenEdges, new Set(tokenEdges.map((_, index) => index)));
    expect(first.boxes).toEqual(all.boxes);
    expect([first.width, first.height]).toEqual([all.width, all.height]);
    expect(first.arrows.map((arrow) => arrow.index)).toEqual([0, 7]);
  });

  it('should keep a sequence aligned when every step can reach the same error response', () => {
    const sequence = Array.from({ length: 10 }, (_, index) => `n${index}`);
    const edges: GraphEdge[] = sequence.slice(0, -1).flatMap((id, index) => [
      { from: id, to: sequence[index + 1]!, kind: 'flow' },
      { from: id, to: 'error', kind: 'error' },
    ]);
    const layout = layoutGraph(nodes(...sequence, 'error'), edges, new Set());
    expect(new Set(layout.boxes.slice(0, -1).map((box) => box.x)).size).toBe(1);
  });

  it('should order horizontal flows from left to right with branches above one another', () => {
    const layout = layoutGraph(forkNodes, forkEdges, new Set([0, 1, 2, 3]), 'LR');
    const [start, left, right, join] = layout.boxes;
    expect(left!.x).toBe(right!.x);
    expect(left!.y + left!.height <= right!.y || right!.y + right!.height <= left!.y).toBe(true);
    expect(start!.x + start!.width < left!.x).toBe(true);
    expect(left!.x + left!.width < join!.x).toBe(true);
  });

  it.each(['TB', 'LR'] as const)('should route skips, errors, cycles and parallel edges without crossing unrelated boxes in %s', (direction) => {
    const edges: GraphEdge[] = [
      ...forkEdges,
      { from: 'start', to: 'join', kind: 'branch', label: 'skip' },
      { from: 'left', to: 'error', kind: 'error' },
      { from: 'right', to: 'error', kind: 'error' },
      { from: 'join', to: 'start', kind: 'branch', label: 'retry' },
      { from: 'right', to: 'right', kind: 'branch', label: 'again' },
      { from: 'start', to: 'left', kind: 'branch', label: 'another condition' },
    ];
    const layout = layoutGraph(nodes('start', 'left', 'right', 'join', 'error', 'isolated'), edges, new Set(edges.map((_, index) => index)), direction);
    expect(layout.arrows.map((arrow) => arrow.index)).toEqual(edges.map((_, index) => index));
    expect(new Set(layout.arrows.map((arrow) => arrow.d)).size).toBe(edges.length);
    const invalidPoints = layout.arrows.flatMap((arrow) => arrow.points).filter((point) =>
      !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > layout.width || point.y > layout.height,
    );
    expect(invalidPoints).toEqual([]);
    const collisions = layout.arrows.flatMap((arrow) => {
      const edge = edges[arrow.index]!;
      return layout.boxes.filter((box) => box.id !== edge.from && box.id !== edge.to).flatMap((box) =>
        arrow.points.slice(1).filter((point, index) => {
          const previous = arrow.points[index]!;
          // Sample each segment, including its interior, to catch a skip routed through a box.
          return Array.from({ length: 21 }, (_, sample) => sample / 20).some((t) => {
            const x = previous.x + (point.x - previous.x) * t;
            const y = previous.y + (point.y - previous.y) * t;
            return x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
          });
        }),
      );
    });
    expect(collisions).toEqual([]);
    expect(layout.arrows.filter((arrow) => arrow.kind === 'error').map((arrow) => arrow.index)).toEqual([5, 6]);
  });

  it('should ignore unknown endpoints and unknown edge indexes without introducing extra boxes', () => {
    const layout = layoutGraph(nodes('only'), [{ from: 'only', to: 'missing', kind: 'flow' }], new Set([0, 99]));
    expect(layout.boxes.map((box) => box.id)).toEqual(['only']);
    expect(layout.arrows).toEqual([]);
    expect(layoutGraph([], [], new Set()).boxes).toEqual([]);
  });
});

describe('truncateColumns', () => {
  it('should count a wide character as two columns', () => {
    expect(textColumns('ab認可')).toBe(6);
    expect(truncateColumns('認可コードを発行する', 9)).toBe('認可コー…');
    expect(truncateColumns('short', 9)).toBe('short');
  });
});

describe('deriveCases of a function', () => {
  it('should include the returning arrow in a loop case and stop after one iteration', () => {
    const edges: GraphEdge[] = [
      { from: 'start', to: 'work', kind: 'flow' },
      { from: 'work', to: 'done', kind: 'branch', label: 'done' },
      { from: 'work', to: 'work', kind: 'branch', label: 'retry' },
    ];
    const cases = deriveCases(nodes('start', 'work', 'done'), edges, endpointOptions);
    expect(cases.map((flowCase) => [flowCase.label, flowCase.nodes, flowCase.edges])).toEqual([
      ['done', ['start', 'work', 'done'], [0, 1]],
      ['retry', ['start', 'work', 'work'], [0, 2]],
    ]);
    expect([...activeOf(cases, new Set(['c1']), edges).edges]).toEqual([0, 2]);
  });

  it('should give a disconnected cycle a selectable case', () => {
    const edges: GraphEdge[] = [
      { from: 'a', to: 'b', kind: 'flow' },
      { from: 'b', to: 'a', kind: 'branch', label: 'repeat' },
    ];
    expect(deriveCases(nodes('a', 'b'), edges, endpointOptions).map((flowCase) => flowCase.edges)).toEqual([[0, 1]]);
  });

  it('should list the path that runs the most first, so the main flow is the one checked at first', () => {
    const edges: GraphEdge[] = [
      { from: 'start', to: 'check', kind: 'flow' },
      { from: 'check', to: 'fail', kind: 'branch', label: '!ok' },
      { from: 'check', to: 'work', kind: 'branch', label: 'ok' },
      { from: 'work', to: 'done', kind: 'flow' },
    ];
    const cases = deriveCases(nodes('start', 'check', 'fail', 'work', 'done'), edges, { errors: 'path', nodeLabel: label, nameBySink: true });
    expect(cases.map((flowCase) => flowCase.label)).toEqual(['ok → DONE', '!ok → FAIL']);
  });
});
