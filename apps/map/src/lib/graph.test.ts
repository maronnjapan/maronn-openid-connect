import { describe, expect, it } from 'vitest';
import { layoutGraph, textColumns, truncateColumns, type GraphEdge, type GraphNode } from './graph';

const nodes = (...ids: string[]): GraphNode[] => ids.map((id) => ({ id }));

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

  it('should keep positions and dimensions stable when the choice changes and draw only the requested arrows', () => {
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
