/**
 * The diagrams of the page, as boxes in a column and arrows between them: the
 * steps of an endpoint, and the flow inside a function. One shape serves
 * both, so they read the same way.
 *
 * A diagram is split into cases: the ways through it, one per path from where
 * it starts to where it ends (`authorization_code`, `refresh_token`, ...). The
 * reader checks the cases to see, and only the boxes and arrows of those take
 * part. Nothing here touches the DOM.
 */

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

  const max = options.maxPaths ?? 24;
  const paths: Path[] = [];
  let overflow = false;
  const walk = (node: string, path: Path, method: string | undefined, refused: ReadonlySet<string>) => {
    if (overflow) return;
    const next = (outgoing.get(node) ?? []).filter((index) => {
      const edge = edges[index] as GraphEdge;
      if (path.nodes.includes(edge.to)) return false;
      const label = edge.label ?? '';
      if (METHOD.test(label)) return method === undefined ? !refused.has(label) : label === method;
      return true;
    });
    if (next.length === 0) {
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
  if (options.errors === 'path') paths.sort((a, b) => b.nodes.length - a.nodes.length);
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
  return sinks.map((sink, position) => {
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
  /** The SVG path. */
  d: string;
  label?: { text: string; x: number; y: number };
}

export interface Layout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  arrows: LayoutArrow[];
}

export const BOX_W = 360;
export const BOX_H = 50;
const GAP = 30;
const PAD = 16;
/** Room on the left for the error arrows, and where their shared vertical line runs. */
const LEFT = 36;
const BUS = 18;
const LANE = 22;
const FIRST_LANE = 26;

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

/**
 * The boxes in a column in the order given, and the arrows that are shown:
 * between neighbours a straight line (its label beside it), the others as
 * arcs on the right, which get lanes of their own where they would overlap.
 * The error arrows all run along one vertical line on the left into the
 * error step, each leaving its box sideways.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[], shown: ReadonlySet<number>): Layout {
  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const hasErrors = edges.some((edge) => edge.kind === 'error');
  const x0 = PAD + (hasErrors ? LEFT : 0);
  const yOf = (index: number) => PAD + index * (BOX_H + GAP);
  const boxes: LayoutBox[] = nodes.map((node, index) => ({ id: node.id, x: x0, y: yOf(index), width: BOX_W, height: BOX_H }));
  const drawn = [...shown].filter((index) => {
    const edge = edges[index];
    return edge !== undefined && position.has(edge.from) && position.has(edge.to);
  });
  drawn.sort((a, b) => a - b);

  // Lanes for the arcs of each side.
  const lanes: Array<Array<[number, number]>> = [];
  const laneOf = (low: number, high: number) => {
    const list = lanes;
    for (let lane = 0; ; lane += 1) {
      const taken = list[lane] ?? [];
      if (taken.every(([a, b]) => high <= a || low >= b)) {
        taken.push([low, high]);
        list[lane] = taken;
        return lane;
      }
    }
  };
  const spans = drawn.map((index) => {
    const edge = edges[index] as GraphEdge;
    const a = position.get(edge.from) as number;
    const b = position.get(edge.to) as number;
    return { index, edge, a, b, span: Math.abs(b - a) };
  });
  const order = [...spans].sort((p, q) => p.span - q.span || Math.min(p.a, p.b) - Math.min(q.a, q.b));
  const laneByIndex = new Map<number, number>();
  for (const item of order) {
    if (item.edge.kind === 'error' || item.b === item.a + 1) continue;
    laneByIndex.set(item.index, laneOf(Math.min(item.a, item.b), Math.max(item.a, item.b)));
  }

  const arrows: LayoutArrow[] = [];
  let right = x0 + BOX_W + PAD;
  for (const { index, edge, a, b } of spans) {
    if (edge.kind === 'error') {
      const bus = x0 - BUS;
      arrows.push({ index, kind: edge.kind, d: `M${x0},${yOf(a) + BOX_H / 2} H${bus} V${yOf(b) + BOX_H / 2} H${x0}` });
      continue;
    }
    const lane = laneByIndex.get(index);
    if (lane === undefined) {
      // Neighbours: a straight line down the middle, the label beside it.
      const x = x0 + BOX_W / 2;
      const arrow: LayoutArrow = { index, kind: edge.kind, d: `M${x},${yOf(a) + BOX_H} L${x},${yOf(b)}` };
      if (edge.label) {
        arrow.label = { text: edge.label, x: x + 8, y: yOf(a) + BOX_H + GAP / 2 + 4 };
        right = Math.max(right, x + 8 + labelWidth(edge.label) + PAD);
      }
      arrows.push(arrow);
      continue;
    }
    const xEdge = x0 + BOX_W;
    // Leave a box a little below its middle and enter one a little above, so an arrow in and an arrow out do not meet.
    const ya = yOf(a) + BOX_H / 2 + 6;
    const yb = yOf(b) + BOX_H / 2 - 6;
    const bulge = FIRST_LANE + lane * LANE;
    // Both control points at 4/3 of the bulge put the apex of the curve at the bulge.
    const arrow: LayoutArrow = { index, kind: edge.kind, d: `M${xEdge},${ya} C${xEdge + bulge * 1.33},${ya} ${xEdge + bulge * 1.33},${yb} ${xEdge},${yb}` };
    if (edge.label) {
      const lx = xEdge + bulge + 6;
      arrow.label = { text: edge.label, x: lx, y: (ya + yb) / 2 + 4 };
      right = Math.max(right, lx + labelWidth(edge.label) + PAD);
    } else {
      right = Math.max(right, xEdge + bulge + PAD);
    }
    arrows.push(arrow);
  }
  return {
    width: right,
    height: Math.max(PAD * 2 + BOX_H, PAD * 2 + nodes.length * (BOX_H + GAP) - GAP),
    boxes,
    arrows,
  };
}
