/**
 * The diagram of a frame as automatically arranged boxes and arrows (Dagre):
 * where each box goes and the route of each arrow, and the text helpers that
 * fit code into a box. Which boxes the chosen way runs through is the
 * trace's business (trace.ts); every box and arrow takes part in the
 * placement, so a choice never moves a box. Nothing here touches the DOM.
 */

import { graphlib, layout as arrange } from '@dagrejs/dagre';

/** A box to place, by its id. */
export interface GraphNode {
  id: string;
}

/** An arrow between two boxes: the flow, a side of a decision, or the way an error takes. */
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'flow' | 'branch' | 'error';
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

/** The placed boxes and the arrows to draw, on a canvas of width × height. */
export interface Layout {
  width: number;
  height: number;
  boxes: LayoutBox[];
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

/** How layoutGraph sizes the boxes. */
export interface LayoutOptions {
  /** The height of a box at a width; every box is BOX_HEIGHT high without it. It is asked again when the width changes. */
  height?: (id: string, width: number) => number;
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

/** Lay out all valid nodes and edges with one alignment, boxes of one width and their own heights, reserving space for the displayed labels. */
function arrangeGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  direction: LayoutDirection,
  align: 'UL' | 'UR' | 'DL' | 'DR',
  width: number,
  heights: ReadonlyMap<string, number>,
) {
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: direction,
    align,
    nodesep: NODE_SEP,
    edgesep: EDGE_SEP,
    ranksep: RANK_SEP,
    marginx: PAD,
    marginy: PAD,
  });
  for (const node of nodes) graph.setNode(node.id, { width, height: heights.get(node.id) ?? BOX_HEIGHT });
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

/** Whether a rank of an arranged top-to-bottom graph holds two boxes: their centres are within 1px of one line. */
function sharesRank(graph: graphlib.Graph, nodes: readonly GraphNode[]): boolean {
  const centres = [...new Set(nodes.map((node) => node.id))].map((id) => graph.node(id).y).sort((a, b) => a - b);
  return centres.some((centre, index) => index > 0 && centre - (centres[index - 1] as number) < 1);
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
 */
export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  shown: ReadonlySet<number>,
  direction: LayoutDirection = 'TB',
  options: LayoutOptions = {},
): Layout & { boxWidth: number } {
  if (nodes.length === 0) return { width: PAD * 2, height: PAD * 2, boxes: [], arrows: [], boxWidth: BOX_WIDE };
  const heightsAt = (width: number): Map<string, number> =>
    new Map(nodes.map((node) => [node.id, options.height === undefined ? BOX_HEIGHT : options.height(node.id, width)]));
  let boxWidth = BOX_WIDE;
  let heights = heightsAt(boxWidth);
  let graph = arrangeGraph(nodes, edges, direction, 'UL', boxWidth, heights);
  // The ranks depend neither on the sizes nor on the alignment, so the first
  // arrangement already tells whether a rank holds two boxes.
  if (direction === 'TB' && sharesRank(graph, nodes)) {
    boxWidth = BOX_NARROW;
    heights = heightsAt(boxWidth);
    graph = arrangeGraph(nodes, edges, direction, 'UL', boxWidth, heights);
  }
  const crossAxis = direction === 'TB' ? 'width' : 'height';
  // Choose the most compact alignment. Averaging the alignments lets shared
  // error paths pull a straight sequence into a wide staircase.
  for (const align of ['UR', 'DL', 'DR'] as const) {
    const candidate = arrangeGraph(nodes, edges, direction, align, boxWidth, heights);
    if ((candidate.graph()[crossAxis] ?? Infinity) < (graph.graph()[crossAxis] ?? Infinity)) graph = candidate;
  }
  const boxes = nodes.map((node) => {
    const box = graph.node(node.id);
    return { id: node.id, x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height };
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
  return { width: graph.graph().width ?? PAD * 2, height: graph.graph().height ?? PAD * 2, boxes, arrows, boxWidth };
}
