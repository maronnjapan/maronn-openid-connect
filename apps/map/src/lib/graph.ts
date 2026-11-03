/**
 * The diagrams of the page, as automatically arranged boxes and arrows: the
 * steps of an endpoint, and the flow inside a function. One shape serves
 * both, so they read the same way.
 *
 * A diagram is split into cases: the ways through it, one per path from where
 * it starts to where it ends (`authorization_code`, `refresh_token`, ...). The
 * reader checks the cases to see, and only the boxes and arrows of those take
 * part. Nothing here touches the DOM.
 */

import { graphlib, layout as arrange } from '@dagrejs/dagre';

export interface GraphNode {
  id: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'flow' | 'branch' | 'error';
}

/** One way through a diagram. */
export interface FlowCase {
  /** Stable within the diagram: `c0`, `c1`, ... in the order the paths are found, or `error`. */
  id: string;
  /** What decides the way: the labels of its arrows (`POST › authenticated`). */
  label: string;
  /**
   * path: the boxes and arrows of one path; exit: every path into one box the
   * diagram ends at (when there are too many paths to list); error: the arrows
   * into the error step from the boxes of the other checked cases.
   */
  kind: 'path' | 'exit' | 'error';
  nodes: string[];
  /** Indexes into the edges of the diagram. */
  edges: number[];
}

export interface CaseOptions {
  /**
   * modifier: the error arrows are one case of their own that adds, to the
   * checked cases, the arrows from their boxes into the error step (an
   * endpoint, where every step may fail). path: an error arrow is followed
   * like any other (a catch block of a function).
   */
  errors: 'modifier' | 'path';
  /** The name of a box, to tell cases apart and to name one by where it ends. */
  nodeLabel: (id: string) => string;
  /** Name each case by the box it ends at too (a function ends at a return or a throw). */
  nameBySink: boolean;
  /** Beyond this many paths the cases are the boxes the diagram ends at. */
  maxPaths?: number;
}

/** The name of the case of a path without a label, when it is the only one. */
export const MAIN_CASE = '標準の流れ';
/** The name of the case that shows the arrows into the error step. */
export const ERROR_CASE = 'エラー時';

const METHOD = /^(GET|POST|PUT|PATCH|DELETE)$/;

interface Path {
  nodes: string[];
  edges: number[];
}

/**
 * The cases of a diagram (see the module comment), in the order the paths are
 * found, the plain flow before its branches; for a function (errors: path),
 * the longest path first.
 */
export function deriveCases(nodes: readonly GraphNode[], edges: readonly GraphEdge[], options: CaseOptions): FlowCase[] {
  const followed = (edge: GraphEdge) => options.errors === 'path' || edge.kind !== 'error';
  const outgoing = new Map<string, number[]>();
  const incoming = new Map<string, number[]>();
  const touched = new Set<string>();
  edges.forEach((edge, index) => {
    touched.add(edge.from);
    touched.add(edge.to);
    if (!followed(edge)) return;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), index]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), index]);
  });
  // The plain flow first, then the branches, then the errors; the order of the source within each.
  const rank = { flow: 0, branch: 1, error: 2 } as const;
  for (const list of outgoing.values()) list.sort((a, b) => rank[(edges[a] as GraphEdge).kind] - rank[(edges[b] as GraphEdge).kind] || a - b);

  // Where a path starts: a box nothing leads into, or a box that only an arrow of another HTTP method leads into.
  const starts: { node: string; refused: Set<string> }[] = [];
  for (const node of nodes) {
    const into = incoming.get(node.id) ?? [];
    const out = outgoing.get(node.id) ?? [];
    if (into.length === 0) {
      // A box only error arrows reach belongs to the error case.
      if (out.length > 0 || !touched.has(node.id)) starts.push({ node: node.id, refused: new Set() });
      continue;
    }
    const methods = into.map((index) => (edges[index] as GraphEdge).label ?? '');
    if (methods.every((label) => METHOD.test(label))) {
      const refused = new Set(methods);
      if (out.some((index) => METHOD.test((edges[index] as GraphEdge).label ?? '') && !refused.has((edges[index] as GraphEdge).label as string))) {
        starts.push({ node: node.id, refused });
      }
    }
  }

  // A disconnected cycle has no source. Give it one entry so its arrows can
  // still be selected; error-only sinks remain part of the error modifier.
  const reachable = new Set<string>();
  const visit = (start: string) => {
    const pending = [start];
    while (pending.length > 0) {
      const node = pending.pop() as string;
      if (reachable.has(node)) continue;
      reachable.add(node);
      for (const index of outgoing.get(node) ?? []) pending.push((edges[index] as GraphEdge).to);
    }
  };
  for (const start of starts) visit(start.node);
  for (const node of nodes) {
    if (reachable.has(node.id) || (outgoing.get(node.id) ?? []).length === 0) continue;
    starts.push({ node: node.id, refused: new Set() });
    visit(node.id);
  }

  const max = options.maxPaths ?? 24;
  const paths: Path[] = [];
  let overflow = false;
  const walk = (node: string, path: Path, method: string | undefined, refused: ReadonlySet<string>) => {
    if (overflow) return;
    const next = (outgoing.get(node) ?? []).filter((index) => {
      const edge = edges[index] as GraphEdge;
      const label = edge.label ?? '';
      if (METHOD.test(label)) return method === undefined ? !refused.has(label) : label === method;
      return true;
    });
    // A loop is a case that returns to a visited box once, rather than an
    // infinite walk or a silently omitted arrow.
    if (next.length === 0 || path.nodes.slice(0, -1).includes(node)) {
      if (paths.length >= max) overflow = true;
      else paths.push({ nodes: [...path.nodes], edges: [...path.edges] });
      return;
    }
    for (const index of next) {
      const edge = edges[index] as GraphEdge;
      const label = edge.label ?? '';
      walk(edge.to, { nodes: [...path.nodes, edge.to], edges: [...path.edges, index] }, method ?? (METHOD.test(label) ? label : undefined), refused);
    }
  };
  for (const start of starts) walk(start.node, { nodes: [start.node], edges: [] }, undefined, start.refused);

  // In a function the path that runs the most is the main one (the others leave early by a return or a throw): list it first.
  if (options.errors === 'path') paths.sort((a, b) => Number(a.edges.some((index) => edges[index]?.kind === 'error')) - Number(b.edges.some((index) => edges[index]?.kind === 'error')) || b.nodes.length - a.nodes.length);
  const cases = overflow ? exitCases(nodes, edges, outgoing, starts.map((start) => start.node), options) : nameCases(paths, edges, options);
  const errorEdges = edges.flatMap((edge, index) => (edge.kind === 'error' ? [index] : []));
  if (options.errors === 'modifier' && errorEdges.length > 0) {
    cases.push({ id: 'error', label: ERROR_CASE, kind: 'error', nodes: [], edges: errorEdges });
  }
  return cases;
}

/** Name the paths by the labels of their arrows; paths the labels do not tell apart are named by the box their last label leaves. */
function nameCases(paths: readonly Path[], edges: readonly GraphEdge[], options: CaseOptions): FlowCase[] {
  const labelsOf = (path: Path, qualify: boolean) => {
    const labelled = path.edges.filter((index) => (edges[index] as GraphEdge).label !== undefined);
    const texts: string[] = [];
    labelled.forEach((index, position) => {
      const edge = edges[index] as GraphEdge;
      const text = qualify && position === labelled.length - 1 ? `${options.nodeLabel(edge.from)}: ${edge.label}` : (edge.label as string);
      if (texts[texts.length - 1] !== text) texts.push(text);
    });
    return texts;
  };
  const sinkOf = (path: Path) => options.nodeLabel(path.nodes[path.nodes.length - 1] as string);
  const nameOf = (path: Path, qualify: boolean) => {
    const labels = labelsOf(path, qualify).join(' › ');
    if (options.nameBySink) return labels === '' ? `→ ${sinkOf(path)}` : `${labels} → ${sinkOf(path)}`;
    return labels;
  };
  let names = paths.map((path) => nameOf(path, false));
  const count = (list: readonly string[], name: string) => list.filter((candidate) => candidate === name).length;
  names = names.map((name, index) => (name !== '' && count(names, name) > 1 ? nameOf(paths[index] as Path, true) : name));
  const unlabelled = names.filter((name) => name === '').length;
  names = names.map((name, index) => (name === '' ? (unlabelled === 1 ? MAIN_CASE : `→ ${sinkOf(paths[index] as Path)}`) : name));
  return paths.map((path, index) => {
    const name = names[index] as string;
    const twins = names.slice(0, index).filter((candidate) => candidate === name).length;
    return { id: `c${index}`, label: twins === 0 ? name : `${name} (${twins + 1})`, kind: 'path', nodes: path.nodes, edges: path.edges };
  });
}

/** One case per box the diagram ends at: every box and arrow on a way from a start to it. */
function exitCases(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  outgoing: ReadonlyMap<string, number[]>,
  starts: readonly string[],
  options: CaseOptions,
): FlowCase[] {
  const forward = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const index of outgoing.get(node) ?? []) {
      const to = (edges[index] as GraphEdge).to;
      if (!forward.has(to)) {
        forward.add(to);
        queue.push(to);
      }
    }
  }
  const sinks = nodes.filter((node) => forward.has(node.id) && (outgoing.get(node.id) ?? []).length === 0);
  const cases = sinks.map((sink, position): FlowCase => {
    const backward = new Set<string>([sink.id]);
    const pending = [sink.id];
    while (pending.length > 0) {
      const node = pending.shift() as string;
      edges.forEach((edge, index) => {
        if (edge.to !== node || !forward.has(edge.from) || backward.has(edge.from)) return;
        if (!(outgoing.get(edge.from) ?? []).includes(index)) return;
        backward.add(edge.from);
        pending.push(edge.from);
      });
    }
    const inCase = nodes.filter((node) => backward.has(node.id)).map((node) => node.id);
    const caseEdges = edges.flatMap((edge, index) => (backward.has(edge.from) && backward.has(edge.to) && (outgoing.get(edge.from) ?? []).includes(index) ? [index] : []));
    return { id: `c${position}`, label: `→ ${options.nodeLabel(sink.id)}`, kind: 'exit', nodes: inCase, edges: caseEdges };
  });
  // Prefer an ordinary completion even when path enumeration overflows.
  if (options.errors === 'path') cases.sort((a, b) => Number(a.edges.some((index) => edges[index]?.kind === 'error')) - Number(b.edges.some((index) => edges[index]?.kind === 'error')) || b.nodes.length - a.nodes.length);
  const counts = new Map<string, number>();
  for (const flowCase of cases) {
    const count = (counts.get(flowCase.label) ?? 0) + 1;
    counts.set(flowCase.label, count);
    if (count > 1) flowCase.label = `${flowCase.label} (${count})`;
  }
  return cases;
}

/** The cases checked by default: the first, so the first view is one way through, not every arrow at once. */
export function defaultChecked(cases: readonly FlowCase[]): Set<string> {
  const first = cases.find((candidate) => candidate.kind !== 'error');
  return new Set(first === undefined ? [] : [first.id]);
}

/** The boxes and arrows the checked cases use. */
export interface Active {
  nodes: Set<string>;
  edges: Set<number>;
}

/** What the checked cases use (see FlowCase): the union of their paths, with the error arrows from those boxes when the error case is checked. */
export function activeOf(cases: readonly FlowCase[], checked: ReadonlySet<string>, edges: readonly GraphEdge[]): Active {
  const nodes = new Set<string>();
  const active = new Set<number>();
  for (const flowCase of cases) {
    if (flowCase.kind === 'error' || !checked.has(flowCase.id)) continue;
    for (const node of flowCase.nodes) nodes.add(node);
    for (const index of flowCase.edges) active.add(index);
  }
  const error = cases.find((flowCase) => flowCase.kind === 'error');
  if (error !== undefined && checked.has(error.id)) {
    const fromAll = nodes.size === 0;
    for (const index of error.edges) {
      const edge = edges[index] as GraphEdge;
      if (!fromAll && !nodes.has(edge.from)) continue;
      active.add(index);
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  }
  return { nodes, edges: active };
}

// ---- layout

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutArrow {
  /** The index of the edge. */
  index: number;
  kind: GraphEdge['kind'];
  /** The SVG path and its routing points, including the intersections with the boxes. */
  d: string;
  points: LayoutPoint[];
  label?: { text: string; x: number; y: number; width: number; height: number };
}

export interface Layout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  arrows: LayoutArrow[];
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export type LayoutDirection = 'TB' | 'LR';

export const BOX_W = 360;
export const BOX_H = 50;
const PAD = 24;
export const EDGE_LABEL_COLUMNS = 48;

/** Whether a character takes two columns (CJK and full-width forms). */
function isWide(char: string): boolean {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char);
}

/** The width of a text in columns: two for a wide character, one for the others. */
export function textColumns(text: string): number {
  let columns = 0;
  for (const char of text) columns += isWide(char) ? 2 : 1;
  return columns;
}

/** Cut a text to a number of columns, with an ellipsis. */
export function truncateColumns(text: string, columns: number): string {
  if (textColumns(text) <= columns) return text;
  let used = 0;
  let out = '';
  for (const char of text) {
    const width = isWide(char) ? 2 : 1;
    if (used + width > columns - 1) break;
    out += char;
    used += width;
  }
  return `${out}…`;
}

/** The pixel width of a label of the arrows (11px text). */
function labelWidth(text: string): number {
  return Math.ceil(textColumns(text) * 6.2) + 8;
}

/** Turn the routing points into an SVG polyline without cutting across its reserved lanes. */
function arrowPath(points: readonly LayoutPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
}

/** Attach a route through the top/bottom or left/right face so it cannot cross a sibling box in the same layer. */
function attachRoute(points: readonly LayoutPoint[], source: LayoutBox, target: LayoutBox, direction: LayoutDirection): LayoutPoint[] {
  const port = (box: LayoutBox, endpoint: LayoutPoint, neighbor: LayoutPoint): LayoutPoint => {
    const margin = Math.min(box.width, box.height) / 2;
    if (direction === 'TB') {
      return {
        x: Math.max(box.x + margin, Math.min(box.x + box.width - margin, endpoint.x)),
        y: neighbor.y < box.y + box.height / 2 ? box.y : box.y + box.height,
      };
    }
    return {
      x: neighbor.x < box.x + box.width / 2 ? box.x : box.x + box.width,
      y: Math.max(box.y + margin, Math.min(box.y + box.height - margin, endpoint.y)),
    };
  };
  const first = port(source, points[0] as LayoutPoint, points[1] as LayoutPoint);
  const last = port(target, points[points.length - 1] as LayoutPoint, points[points.length - 2] as LayoutPoint);
  return [first, ...points.slice(1, -1), last];
}

/** Connect a self loop to its box through the space reserved for its label. */
function selfLoopPoints(box: LayoutBox, label: LayoutPoint & { width: number; height: number }, direction: LayoutDirection): LayoutPoint[] {
  if (direction === 'TB') {
    const side = box.x + box.width;
    const outside = label.x + label.width / 2 + 8;
    const top = box.y + box.height / 4;
    const bottom = box.y + box.height * 3 / 4;
    return [{ x: side, y: top }, { x: outside, y: top }, { x: outside, y: bottom }, { x: side, y: bottom }];
  }
  const side = box.y + box.height;
  const outside = label.y + label.height / 2 + 8;
  const left = box.x + box.width / 4;
  const right = box.x + box.width * 3 / 4;
  return [{ x: left, y: side }, { x: left, y: outside }, { x: right, y: outside }, { x: right, y: side }];
}

/** Lay out all valid nodes and edges with one alignment, reserving space for the displayed labels. */
function arrangeGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  direction: LayoutDirection,
  align: 'UL' | 'UR' | 'DL' | 'DR',
) {
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: direction,
    align,
    nodesep: 48,
    edgesep: 24,
    ranksep: 56,
    marginx: PAD,
    marginy: PAD,
  });
  for (const node of nodes) graph.setNode(node.id, { width: BOX_W, height: BOX_H });
  edges.forEach((edge, index) => {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) return;
    const text = truncateColumns(edge.label ?? '', EDGE_LABEL_COLUMNS);
    graph.setEdge(edge.from, edge.to, {
      width: text === '' ? 0 : labelWidth(text),
      height: text === '' ? 0 : 22,
      labelpos: 'c',
      // Keep the main path compact; give branches and errors their own lanes.
      weight: edge.kind === 'flow' ? 4 : 1,
    }, String(index));
  });
  arrange(graph);
  return graph;
}

/**
 * Arrange the complete graph in layers, placing sibling branches alongside
 * one another and reserving lanes for skips, loops and error paths. All edges
 * participate in placement so checking a case never moves a box or its label;
 * only the requested arrows are returned for drawing. Missing endpoints are
 * ignored. Parallel edges retain their original indexes.
 */
export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  shown: ReadonlySet<number>,
  direction: LayoutDirection = 'TB',
): Layout {
  if (nodes.length === 0) return { width: PAD * 2, height: PAD * 2, boxes: [], arrows: [] };
  let graph = arrangeGraph(nodes, edges, direction, 'UL');
  const crossAxis = direction === 'TB' ? 'width' : 'height';
  // Choose the most compact alignment. Averaging the alignments lets shared
  // error paths pull a straight sequence into a wide staircase.
  for (const align of ['UR', 'DL', 'DR'] as const) {
    const candidate = arrangeGraph(nodes, edges, direction, align);
    if ((candidate.graph()[crossAxis] ?? Infinity) < (graph.graph()[crossAxis] ?? Infinity)) graph = candidate;
  }
  const boxes = nodes.map((node) => {
    const box = graph.node(node.id);
    return { id: node.id, x: box.x - BOX_W / 2, y: box.y - BOX_H / 2, width: BOX_W, height: BOX_H };
  });
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const arrows: LayoutArrow[] = [];
  edges.forEach((edge, index) => {
    if (!shown.has(index) || !graph.hasEdge(edge.from, edge.to, String(index))) return;
    const route = graph.edge(edge.from, edge.to, String(index));
    const points = edge.from === edge.to
      ? selfLoopPoints(byId.get(edge.from) as LayoutBox, route, direction)
      : attachRoute(route.points, byId.get(edge.from) as LayoutBox, byId.get(edge.to) as LayoutBox, direction);
    const arrow: LayoutArrow = { index, kind: edge.kind, d: arrowPath(points), points };
    if (edge.label) arrow.label = { text: edge.label, x: route.x, y: route.y, width: route.width, height: route.height };
    arrows.push(arrow);
  });
  return { width: graph.graph().width ?? PAD * 2, height: graph.graph().height ?? PAD * 2, boxes, arrows };
}
