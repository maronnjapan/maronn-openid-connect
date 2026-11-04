/**
 * The diagram of a frame as automatically arranged boxes and arrows (Dagre):
 * where each box goes, the rectangle of each region (a group of boxes, such
 * as the ones a `try` guards), the route of each arrow, and the text helpers
 * that fit code into a box. Which boxes the chosen way runs through is the
 * trace's business (trace.ts); every box and arrow takes part in the
 * placement, so a choice never moves a box. Nothing here touches the DOM.
 */

import { graphlib, layout as arrange } from '@dagrejs/dagre';

/** A box to place, by its id. */
export interface GraphNode {
  id: string;
}

/** An arrow between two boxes, or from or to a region: the flow, a side of a decision, or the way an error takes. */
export interface GraphEdge {
  /** A box, or a region (GraphGroup): the arrow then leaves from its border. */
  from: string;
  /** A box, or a region: the arrow then ends at its border. */
  to: string;
  label?: string;
  kind: 'flow' | 'branch' | 'error';
}

/** A region: boxes laid out together as one cluster and drawn inside one rectangle, with room for a label at its top. */
export interface GraphGroup {
  id: string;
  /** The region it is inside, by id. */
  parent?: string;
  /** Every box it encloses, by id, those of the regions inside it included, in the order they read. */
  members: readonly string[];
}

// ---- layout

/** A placed box: its top-left corner and its size. */
export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A placed region: the rectangle that encloses its boxes with a margin, the room of its label at the top included. */
export interface LayoutGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An arrow to draw: its route and, when it has one, the place of its label. */
export interface LayoutArrow {
  /** The index of the edge. */
  index: number;
  kind: GraphEdge['kind'];
  /** The SVG path and its routing points, including the intersections with the boxes. */
  d: string;
  points: LayoutPoint[];
  label?: { text: string; x: number; y: number; width: number; height: number };
}

/** The placed boxes and regions and the arrows to draw, on a canvas of width × height. */
export interface Layout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  /** The regions that enclose boxes, in the order of LayoutOptions.groups; a region with no box is left out. */
  groups: LayoutGroup[];
  arrows: LayoutArrow[];
}

/** A point of a route. */
export interface LayoutPoint {
  x: number;
  y: number;
}

/** The direction of the flow: top to bottom, or left to right. */
export type LayoutDirection = 'TB' | 'LR';

/** The width of every box, unless a rank of a top-to-bottom flow holds two boxes. */
export const BOX_WIDE = 320;
/** The width of every box of a top-to-bottom flow in which a rank holds two boxes, so the sides stand next to one another. */
export const BOX_NARROW = 200;
/** The height of a box when the caller does not size the boxes. */
export const BOX_HEIGHT = 48;
/** The margin around the boxes. */
const PAD = 12;
/** The space between the boxes of a rank, between parallel arrows, and between ranks. */
const NODE_SEP = 16;
const EDGE_SEP = 12;
const RANK_SEP = 20;
/** The columns of an arrow's label; a longer label is cut. */
export const EDGE_LABEL_COLUMNS = 48;

/** The least room between the border of a region and the boxes it encloses. */
const GROUP_PAD = 12;

/** How layoutGraph sizes the boxes, and the regions it draws around them. */
export interface LayoutOptions {
  /** The height of a box at a width; every box is BOX_HEIGHT high without it. It is asked again when the width changes. */
  height?: (id: string, width: number) => number;
  /** The regions: each encloses its members; a region inside another lies inside it. */
  groups?: readonly GraphGroup[];
  /** The room the label of a region takes at its top, from its border to its first box (GROUP_PAD without it). */
  header?: (id: string) => number;
}

/** Whether a character takes two columns (CJK and full-width forms). */
function isWide(char: string): boolean {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char);
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

/** How wide the characters of a font draw: a wide character (CJK, full-width) and, on average, any other, in pixels. */
export interface FontWidths {
  wide: number;
  narrow: number;
}

/** The pixels a text takes in a font (see FontWidths). */
export function textPixels(text: string, font: FontWidths): number {
  let pixels = 0;
  for (const char of text) pixels += isWide(char) ? font.wide : font.narrow;
  return pixels;
}

/** Cut a text to the pixels it may take in a font, with an ellipsis (as wide as a narrow character) that the room includes. */
export function truncatePixels(text: string, room: number, font: FontWidths): string {
  if (textPixels(text, font) <= room) return text;
  let used = font.narrow;
  let out = '';
  for (const char of text) {
    const width = isWide(char) ? font.wide : font.narrow;
    if (used + width > room) break;
    out += char;
    used += width;
  }
  return `${out}…`;
}

/** How well a line reads ending after `char` when `next` follows: 1 at a space or after '、', 2 after '.' or '(', 3 between a lower-case and an upper-case letter, 0 not at all. */
function breakRank(char: string, next: string): number {
  if (char === ' ' || next === ' ' || char === '、') return 1;
  if (char === '.' || char === '(') return 2;
  return /[a-z]/.test(char) && /[A-Z]/.test(next) ? 3 : 0;
}

/** The characters no line starts with: closing brackets and the punctuation that follows a word. */
const NO_LINE_START = /[)\]},;、。，．）］｝〕〉》」』】]/;
/** The columns a line may run past its end to keep the closing punctuation that follows it. */
const HANG = 2;

/** The end (an index of `chars`) of the spaces and the closing punctuation the rest of a text starts with at `at`; undefined when the rest starts otherwise. */
function closingRun(chars: readonly string[], at: number): number | undefined {
  let index = at;
  while (chars[index] === ' ') index += 1;
  if (!NO_LINE_START.test(chars[index] ?? '')) return undefined;
  while (NO_LINE_START.test(chars[index] ?? '')) index += 1;
  return index;
}

/** A good place for a line to end: the string index, how well it reads (1 best), and whether it falls in the line's last 40%. */
interface LineBreak {
  end: number;
  rank: number;
  late: boolean;
}

/**
 * Where a line of at most `columns` columns may end: its good breaks in
 * order, none of which leaves the next line starting with closing
 * punctuation, and the limit, never before the first character. Closing
 * punctuation (and the spaces before it) that would start the next line
 * hangs past the limit when it takes at most HANG columns; when it takes
 * more, the limit moves back before the characters it follows.
 */
function lineEnds(text: string, columns: number): { breaks: LineBreak[]; limit: number } {
  const chars = [...text];
  const breaks: LineBreak[] = [];
  let used = 0;
  let limit = 0;
  let at = 0;
  for (; at < chars.length; at += 1) {
    const char = chars[at] as string;
    const width = isWide(char) ? 2 : 1;
    if (used + width > columns) break;
    used += width;
    limit += char.length;
    const rank = closingRun(chars, at + 1) === undefined ? breakRank(char, chars[at + 1] ?? '') : 0;
    if (rank > 0) breaks.push({ end: limit, rank, late: used >= columns * 0.6 });
  }
  const run = closingRun(chars, at);
  if (run !== undefined) {
    const hung = chars.slice(at, run).join('');
    if (used + textColumns(hung) <= columns + HANG) limit += hung.length;
    else {
      let back = at - 1;
      while (back > 0 && closingRun(chars, back) !== undefined) back -= 1;
      if (back > 0) limit = chars.slice(0, back).join('').length;
    }
  }
  return { breaks, limit: limit > 0 ? limit : (chars[0]?.length ?? 0) };
}

/** Whether a text fits on one line of `columns` columns, the closing punctuation at its end hanging past it (see lineEnds). */
function fitsLine(text: string, columns: number): boolean {
  return lineEnds(text, columns).limit >= text.length;
}

/** The end of the best-reading break of a list, the latest of its rank; undefined for none. */
function bestBreak(breaks: readonly LineBreak[]): number | undefined {
  return breaks.reduce<LineBreak | undefined>((best, candidate) => (best === undefined || candidate.rank <= best.rank ? candidate : best), undefined)?.end;
}

/** Whether a text fits in a number of lines when every line is filled to the limit, the fullest a line can be. */
function fitsAtLimits(text: string, columns: number, lines: number): boolean {
  let rest = text;
  for (let line = 1; line < lines && !fitsLine(rest, columns); line += 1) rest = rest.slice(lineEnds(rest, columns).limit).trimStart();
  return fitsLine(rest, columns);
}

/**
 * Wrap a text into at most `maxLines` lines (at least one) of `columns`
 * columns, a wide character taking two. While the whole text can still fit,
 * a line ends at a good break, preferably in its last 40%: at a space or
 * after '、' first, then after '.' or '(', then before an upper-case letter
 * that follows a lower-case one; else at the limit. A text too long for its
 * lines fills them, ending a line at a good break only in its last 40%, and
 * only its last line ends with '…'. The spaces at a break are dropped. No
 * line starts with closing punctuation (`)`, `]`, `}`, `,`, `;`, `、`, `。`,
 * `）`, `」`...): it stays at the end of the line before, which may run up to
 * HANG columns past its end for it (FlowDiagram squeezes a line the font
 * draws wider than its room), else that line ends a character earlier. So
 * `buildAccessTokenAudience()` keeps one line at 25 columns.
 */
export function wrapColumns(text: string, columns: number, maxLines: number): string[] {
  if (fitsLine(text, columns)) return [text];
  if (maxLines <= 1) return [truncateColumns(text, columns)];
  const { breaks, limit } = lineEnds(text, columns);
  const restFrom = (end: number) => text.slice(end).trimStart();
  const keepsWhole = (end: number) => fitsAtLimits(restFrom(end), columns, maxLines - 1);
  const whole = breaks.filter((candidate) => keepsWhole(candidate.end));
  const end = bestBreak(whole.filter((candidate) => candidate.late))
    ?? bestBreak(whole)
    ?? (keepsWhole(limit) ? limit : undefined)
    ?? breaks.filter((candidate) => candidate.late).at(-1)?.end
    ?? limit;
  const rest = restFrom(end);
  return [text.slice(0, end).trimEnd(), ...(rest === '' ? [] : wrapColumns(rest, columns, maxLines - 1))];
}

/** The closing bracket of each opening one. */
const CLOSERS: Readonly<Partial<Record<string, string>>> = { '(': ')', '[': ']', '{': '}' };

/** The words whose parenthesis opens no call: if (…), catch (…), typeof (…)... */
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'throw', 'typeof', 'instanceof', 'await', 'yield', 'void', 'delete', 'in', 'of', 'case', 'do', 'else', 'function']);

/** Whether the '(' at `index` opens the arguments of a call: it follows a name, ')', ']', '?.' or type arguments. */
function opensCall(code: string, index: number): boolean {
  const before = code.slice(0, index);
  if (/(?:[)\]]|\?\.|[^=\s]>)$/.test(before)) return true;
  const name = /[A-Za-z_$][\w$]*$/.exec(before)?.[0];
  return name !== undefined && !NOT_CALLS.has(name);
}

/** The index just past the string or template literal that starts at `start`, or the end of the code when it does not close. */
function literalEnd(code: string, start: number): number {
  const quote = code[start];
  let index = start + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === '\\') index += 2;
    else if (char === quote) return index + 1;
    else if (quote === '`' && char === '$' && code[index + 1] === '{') index = closingBracket(code, index + 1) + 1;
    else index += 1;
  }
  return code.length;
}

/** The index of the bracket that closes the one at `open`, past nested brackets and literals, or the end of the code when it does not close. */
function closingBracket(code: string, open: number): number {
  const closers: string[] = [];
  let index = open;
  while (index < code.length) {
    const char = code[index] as string;
    if (char === "'" || char === '"' || char === '`') {
      index = literalEnd(code, index);
      continue;
    }
    const closer = CLOSERS[char];
    if (closer !== undefined) closers.push(closer);
    else if (char === closers[closers.length - 1]) {
      closers.pop();
      if (closers.length === 0) return index;
    }
    index += 1;
  }
  return code.length;
}

/**
 * Shorten code by replacing the arguments of every call with (…), nested
 * calls and literals included: return oauthError('invalid_request', `…`)
 * reads return oauthError(…). Parentheses that open no call, an empty
 * argument list and the inside of string and template literals stay as they
 * are; an argument list the text cuts off also reads (…).
 */
export function compactArguments(code: string): string {
  let out = '';
  let index = 0;
  while (index < code.length) {
    const char = code[index] as string;
    if (char === "'" || char === '"' || char === '`') {
      const end = literalEnd(code, index);
      out += code.slice(index, end);
      index = end;
    } else if (char === '(' && opensCall(code, index)) {
      const close = closingBracket(code, index);
      out += code.slice(index + 1, close).trim() === '' && close < code.length ? '()' : '(…)';
      index = close + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
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

/** A region of a graph as the layout takes it: its boxes (only those the graph has, in order) and its parent, when that is a region the graph has too. */
interface Cluster {
  id: string;
  parent: string | undefined;
  members: string[];
  /** How many regions it is inside. */
  depth: number;
}

/** The regions that enclose at least one box of the graph, in the order given; a region whose id is a box's is left out, and so is a parent that loops. */
function clustersOf(nodes: readonly GraphNode[], groups: readonly GraphGroup[]): Cluster[] {
  const boxes = new Set(nodes.map((node) => node.id));
  const valid = groups.filter((group) => !boxes.has(group.id) && group.members.some((id) => boxes.has(id)));
  const byId = new Map(valid.map((group) => [group.id, group]));
  const depthOf = (group: GraphGroup, seen: ReadonlySet<string>): number => {
    const parent = group.parent === undefined ? undefined : byId.get(group.parent);
    return parent === undefined || seen.has(parent.id) ? 0 : 1 + depthOf(parent, new Set([...seen, group.id]));
  };
  return valid
    .map((group) => ({ id: group.id, parent: group.parent !== undefined && byId.has(group.parent) && group.parent !== group.id ? group.parent : undefined, members: group.members.filter((id) => boxes.has(id)), depth: depthOf(group, new Set([group.id])) }));
}

/** The regions, outer ones before the ones inside them. */
function outerFirst(clusters: readonly Cluster[]): Cluster[] {
  return [...clusters].sort((a, b) => a.depth - b.depth);
}

/** The box an arrow is laid out from or to: the box itself, or for a region its last box (an arrow from it) or its first (an arrow to it); undefined when there is none. */
function endpointOf(id: string, boxes: ReadonlySet<string>, clusters: ReadonlyMap<string, Cluster>, end: 'from' | 'to'): string | undefined {
  if (boxes.has(id)) return id;
  const members = clusters.get(id)?.members ?? [];
  return end === 'from' ? members[members.length - 1] : members[0];
}

/** Lay out all valid nodes and edges with one alignment, boxes of one width and their own heights, each region a cluster around its boxes, reserving space for the displayed labels. */
function arrangeGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  direction: LayoutDirection,
  align: 'UL' | 'UR' | 'DL' | 'DR',
  width: number,
  heights: ReadonlyMap<string, number>,
  clusters: readonly Cluster[],
) {
  const graph = new graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({
    rankdir: direction,
    align,
    nodesep: NODE_SEP,
    edgesep: EDGE_SEP,
    ranksep: RANK_SEP,
    marginx: PAD,
    marginy: PAD,
  });
  const boxes = new Set(nodes.map((node) => node.id));
  const byCluster = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  for (const node of nodes) graph.setNode(node.id, { width, height: heights.get(node.id) ?? BOX_HEIGHT });
  for (const cluster of clusters) graph.setNode(cluster.id, {});
  for (const cluster of clusters) if (cluster.parent !== undefined) graph.setParent(cluster.id, cluster.parent);
  // A box goes in the deepest region that encloses it: the last of the outer-first order to name it.
  for (const cluster of outerFirst(clusters)) for (const member of cluster.members) graph.setParent(member, cluster.id);
  edges.forEach((edge, index) => {
    const from = endpointOf(edge.from, boxes, byCluster, 'from');
    const to = endpointOf(edge.to, boxes, byCluster, 'to');
    if (from === undefined || to === undefined) return;
    const text = truncateColumns(edge.label ?? '', EDGE_LABEL_COLUMNS);
    graph.setEdge(from, to, {
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

/** Whether a rank of an arranged top-to-bottom graph holds two boxes: their centres are within 1px of one line. */
function sharesRank(graph: graphlib.Graph, nodes: readonly GraphNode[]): boolean {
  const centres = [...new Set(nodes.map((node) => node.id))].map((id) => graph.node(id).y).sort((a, b) => a - b);
  return centres.some((centre, index) => index > 0 && centre - (centres[index - 1] as number) < 1);
}

/** A route from its start drawn from where it leaves a rectangle: the part of it inside is dropped. A route that starts outside, or never leaves, stays whole. */
function leaving(points: readonly LayoutPoint[], rect: LayoutGroup): LayoutPoint[] {
  const inside = (point: LayoutPoint) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  const at = points.findIndex((point, index) => index > 0 && !inside(point));
  if (at <= 0 || !inside(points[0] as LayoutPoint)) return [...points];
  const a = points[at - 1] as LayoutPoint;
  const b = points[at] as LayoutPoint;
  // The share of the segment a → b at which it crosses a side of the rectangle.
  const exit = (from: number, to: number, low: number, high: number) => (to > high ? (high - from) / (to - from) : to < low ? (low - from) / (to - from) : Infinity);
  const t = Math.max(0, Math.min(1, exit(a.x, b.x, rect.x, rect.x + rect.width), exit(a.y, b.y, rect.y, rect.y + rect.height)));
  return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ...points.slice(at)];
}

/** A route as Dagre gives it, before it is attached to its boxes: its points, and the place of its label (a self loop's too). */
interface Route {
  from: string;
  to: string;
  points: LayoutPoint[];
  label: { x: number; y: number; width: number; height: number };
}

/**
 * Where an arranged graph puts the boxes, the regions and every arrow. A
 * region is the rectangle Dagre gives its cluster, grown to keep 8px around
 * its boxes and the regions inside it; then, from the top down, the room its
 * label takes (options.header) is made at its top by moving down everything
 * below its top border, which no box crosses. An arrow from or to a region
 * starts or ends at its border.
 */
function place(graph: graphlib.Graph, nodes: readonly GraphNode[], edges: readonly GraphEdge[], clusters: readonly Cluster[], direction: LayoutDirection, header: (id: string) => number): Layout {
  const boxes: LayoutBox[] = nodes.map((node) => {
    const box = graph.node(node.id);
    return { id: node.id, x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height };
  });
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const below = (cluster: Cluster): Cluster[] => clusters.filter((other) => other.parent === cluster.id);
  // The rectangles, the regions inside a region before it.
  const rects = new Map<string, LayoutGroup>();
  for (const cluster of outerFirst(clusters).reverse()) {
    const node = graph.node(cluster.id);
    const parts = [
      { x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height },
      ...cluster.members.map((id) => byId.get(id) as LayoutBox).map((box) => ({ x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 })),
      ...below(cluster).map((child) => rects.get(child.id) as LayoutGroup).map((rect) => ({ x: rect.x - 8, y: rect.y - 8, width: rect.width + 16, height: rect.height + 16 })),
    ];
    const left = Math.min(...parts.map((part) => part.x));
    const top = Math.min(...parts.map((part) => part.y));
    const right = Math.max(...parts.map((part) => part.x + part.width));
    const bottom = Math.max(...parts.map((part) => part.y + part.height));
    rects.set(cluster.id, { id: cluster.id, x: left, y: top, width: right - left, height: bottom - top });
  }
  const groups = clusters.map((cluster) => rects.get(cluster.id) as LayoutGroup);
  const boxSet = new Set(boxes.map((box) => box.id));
  const byCluster = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const routes: Array<Route | undefined> = edges.map((edge, index) => {
    const from = endpointOf(edge.from, boxSet, byCluster, 'from');
    const to = endpointOf(edge.to, boxSet, byCluster, 'to');
    if (from === undefined || to === undefined || !graph.hasEdge(from, to, String(index))) return undefined;
    const route = graph.edge(from, to, String(index));
    return { from, to, points: (route.points as LayoutPoint[]).map((point) => ({ x: point.x, y: point.y })), label: { x: route.x, y: route.y, width: route.width, height: route.height } };
  });
  let width = graph.graph().width ?? PAD * 2;
  let height = graph.graph().height ?? PAD * 2;
  // Make the room of each label, outer regions first: everything at or below the line just under its top border moves down.
  const descendants = (cluster: Cluster): Cluster[] => below(cluster).flatMap((child) => [child, ...descendants(child)]);
  const order = [...clusters].sort((a, b) => (rects.get(a.id) as LayoutGroup).y - (rects.get(b.id) as LayoutGroup).y || a.depth - b.depth);
  for (const cluster of order) {
    const rect = rects.get(cluster.id) as LayoutGroup;
    const tops = [...cluster.members.map((id) => (byId.get(id) as LayoutBox).y), ...descendants(cluster).map((child) => (rects.get(child.id) as LayoutGroup).y)];
    const by = header(cluster.id) - (Math.min(...tops) - rect.y);
    if (by <= 0) continue;
    const at = rect.y + 0.5;
    for (const box of boxes) if (box.y >= at) box.y += by;
    for (const other of groups) {
      if (other.y >= at) other.y += by;
      else if (other.y + other.height >= at) other.height += by;
    }
    for (const route of routes) {
      if (route === undefined) continue;
      for (const point of route.points) if (point.y >= at) point.y += by;
      if (route.label.y - route.label.height / 2 >= at) route.label.y += by;
    }
    height += by;
  }
  width = Math.max(width, ...groups.map((group) => group.x + group.width + PAD));
  height = Math.max(height, ...groups.map((group) => group.y + group.height + PAD));
  const arrows: LayoutArrow[] = [];
  routes.forEach((route, index) => {
    const edge = edges[index] as GraphEdge;
    if (route === undefined) return;
    let points = route.from === route.to
      ? selfLoopPoints(byId.get(route.from) as LayoutBox, route.label, direction)
      : attachRoute(route.points, byId.get(route.from) as LayoutBox, byId.get(route.to) as LayoutBox, direction);
    const source = rects.get(edge.from);
    const target = rects.get(edge.to);
    if (source !== undefined) points = leaving(points, source);
    if (target !== undefined) points = leaving([...points].reverse(), target).reverse();
    const arrow: LayoutArrow = { index, kind: edge.kind, d: arrowPath(points), points };
    if (edge.label) arrow.label = { text: edge.label, ...route.label };
    arrows.push(arrow);
  });
  return { width, height, boxes, groups, arrows };
}

/**
 * Arrange the complete graph in layers, placing sibling branches alongside
 * one another and reserving lanes for skips, loops and error paths. All edges
 * participate in placement so checking a case never moves a box or its label;
 * only the requested arrows are returned for drawing. Missing endpoints are
 * ignored. Parallel edges retain their original indexes.
 *
 * Every box is BOX_WIDE wide, or BOX_NARROW in a top-to-bottom flow where a
 * rank holds two boxes, so the width follows from the graph alone, never
 * from the room it is shown in; boxWidth tells which. Each box is as high as
 * options.height says for that width.
 *
 * Each region of options.groups is a cluster of Dagre's compound layout: its
 * boxes stay together, no other box comes between them, and its rectangle
 * encloses them with the room of its label (options.header) at the top. An
 * edge from or to a region is laid out from its last box or to its first,
 * and drawn from or to its border. Of the four alignments the most compact
 * across the flow is kept.
 */
export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  shown: ReadonlySet<number>,
  direction: LayoutDirection = 'TB',
  options: LayoutOptions = {},
): Layout & { boxWidth: number } {
  if (nodes.length === 0) return { width: PAD * 2, height: PAD * 2, boxes: [], groups: [], arrows: [], boxWidth: BOX_WIDE };
  const clusters = clustersOf(nodes, options.groups ?? []);
  const header = (id: string) => options.header?.(id) ?? GROUP_PAD;
  const heightsAt = (width: number): Map<string, number> =>
    new Map(nodes.map((node) => [node.id, options.height === undefined ? BOX_HEIGHT : options.height(node.id, width)]));
  let boxWidth = BOX_WIDE;
  let heights = heightsAt(boxWidth);
  let graph = arrangeGraph(nodes, edges, direction, 'UL', boxWidth, heights, clusters);
  // The ranks depend neither on the sizes nor on the alignment, so the first
  // arrangement already tells whether a rank holds two boxes.
  if (direction === 'TB' && sharesRank(graph, nodes)) {
    boxWidth = BOX_NARROW;
    heights = heightsAt(boxWidth);
    graph = arrangeGraph(nodes, edges, direction, 'UL', boxWidth, heights, clusters);
  }
  const crossAxis = direction === 'TB' ? 'width' : 'height';
  // Choose the most compact alignment. Averaging the alignments lets shared
  // error paths pull a straight sequence into a wide staircase.
  let best = place(graph, nodes, edges, clusters, direction, header);
  for (const align of ['UR', 'DL', 'DR'] as const) {
    const candidate = place(arrangeGraph(nodes, edges, direction, align, boxWidth, heights, clusters), nodes, edges, clusters, direction, header);
    if (candidate[crossAxis] < best[crossAxis]) best = candidate;
  }
  return { ...best, arrows: best.arrows.filter((arrow) => shown.has(arrow.index)), boxWidth };
}
