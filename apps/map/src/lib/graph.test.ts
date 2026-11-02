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
  it('should stack the boxes in order and draw only the arrows shown', () => {
    const layout = layoutGraph(tokenNodes, tokenEdges, new Set([0, 7]));
    expect(layout.boxes.map((box) => box.id)).toEqual(tokenNodes.map((node) => node.id));
    expect(layout.boxes[1]!.y).toBeGreaterThan(layout.boxes[0]!.y);
    expect(layout.arrows.map((arrow) => arrow.index)).toEqual([0, 7]);
  });

  it('should draw neighbours straight and the others as arcs with their label', () => {
    const layout = layoutGraph(tokenNodes, tokenEdges, new Set([0, 7]));
    expect(layout.arrows[0]!.d).toContain(' L');
    expect(layout.arrows[1]!.d).toContain(' C');
    expect(layout.arrows[1]!.label?.text).toBe('answered');
  });

  it('should give overlapping arcs lanes of their own, and widen the drawing for them', () => {
    const one = layoutGraph(tokenNodes, tokenEdges, new Set([2]));
    const two = layoutGraph(tokenNodes, tokenEdges, new Set([2, 7]));
    expect(two.width).toBeGreaterThan(one.width);
  });

  it('should run the error arrows along one line on the left', () => {
    const layout = layoutGraph(tokenNodes, tokenEdges, new Set([8, 9]));
    expect(layout.arrows.map((arrow) => arrow.d.match(/H(\d+)/)?.[1])).toEqual(['34', '34']);
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
