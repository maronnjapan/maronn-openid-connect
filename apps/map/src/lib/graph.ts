/**
 * The diagram of a frame as automatically arranged boxes and arrows (Dagre):
 * where each box goes and the route of each arrow. Which boxes the chosen
 * way runs through is the trace's business (trace.ts); every box and arrow
 * takes part in the placement, so a choice never moves a box. Nothing here
 * touches the DOM.
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
