/**
 * The flowchart of a frame for the flow view: the frame's diagram (diagram.ts)
 * drawn the way a Mermaid flowchart reads, so the reader sees what the flow
 * does, where it splits and how it ends, and the playback can move along it.
 * Nothing here touches the DOM.
 *
 * - The start is a stadium with the frame's name (`POST /token`, the
 *   signature of a function), and what the function does under it.
 * - A box is a rounded rectangle of two lines: its words, as the diagram
 *   says them, and what it does in this flow: the kind of an endpoint's step
 *   and the values it reads and hands on (`検証 · params, authorization →
 *   tokenClient`), else its code.
 * - A decision the diagram draws as a box of its own (a guard, a fork, a case
 *   by case, a branching expression, a loop) is a rhombus with its condition,
 *   on at most two lines.
 * - Every way a box ends the frame (a row of the diagram: `→ 終わり`,
 *   `→ 失敗 ×3`, the catch of a region that ends at once) is a terminal node
 *   of its own: a stadium for an end (`応答して終わる` and what it returns), a
 *   red rounded node for a failure (`失敗: TokenError(invalid_client)`). The
 *   arrow to it is labeled with the side in words (成立, 応答した, 例外), and the
 *   box's other arrow with the side it is (不成立, 応答なし). A box that is
 *   itself a return or a throw is drawn as such a terminal.
 * - A region (the body of a `try`) is a subgraph; its catch is reached by a
 *   red dashed arrow labeled 例外.
 * - An arrow between two steps of an endpoint carries the values one hands
 *   to the next (the produces of the first that it or a later step consumes).
 *
 * The chart keeps the ids of the diagram (`start`, `n:<node>`, `g:<try>`), so
 * a scene of the playback (playback.ts), whose shape is a box or a region of
 * the diagram, names its node of the chart; an exit is `x:<box>|<row>`.
 * chartWay reads the scenes of a frame as the way through its chart: the
 * nodes and arrows the request takes, and the exit each scene ends at.
 *
 * Why a chart of its own rather than the diagram: the diagram is drawn for a
 * pane beside the outline, where boxes of one line read at a glance and the
 * exits stay tags; the flow view is the page's stage and plays a request, so
 * it draws what each box does, every exit as a place the token can reach,
 * and every arrow (not only those of the chosen way), all from the same
 * folding of the tree, so the two never disagree on what a box holds.
 */
import type { FlowStep, FlowTree, TreeNode } from '../types';
import type { Diagram, DiagramGroup, DiagramNode, DiagramRow } from './diagram';
import {
  compactArguments,
  LABEL_HEIGHT,
  labelWidth,
  layoutGraph,
  textPixels,
  truncatePixels,
  wrapColumns,
  type FontWidths,
  type GraphEdge,
  type GraphGroup,
  type Layout,
  type LayoutArrow,
  type LayoutBox,
  type LayoutDirection,
  type LayoutGroup,
  type LayoutPoint,
} from './graph';
import { STEP_KIND_WORDS, type Scene } from './playback';
import { findNode } from './trace';
import { firstSentence, sideLabel, type WordSource } from './words';

/** The shape a node of the chart is drawn as: a stadium for the start, a rounded rectangle for what runs, a rhombus for a decision, a stadium for an end, a red rounded node for a failure. */
export type ChartShape = 'start' | 'process' | 'decision' | 'end' | 'failure';

/** A node of the chart. */
export interface ChartNode {
  /** The id of the diagram's box it draws (`start`, `n:<node>`), or `x:<box or region>|<row>` for an exit. */
  id: string;
  shape: ChartShape;
  /** Its words in full, for its label and its card. */
  title: string;
  /** The words as drawn: one line, or two for a decision, cut with an ellipsis to its room. */
  lines: string[];
  /** The title is code: it is drawn in the code font. */
  code: boolean;
  /** The second line: what it does in this flow (the kind of a step and its values, the code of a box, what an exit returns), cut to its room. */
  detail?: string;
  /** The detail in full. */
  detailFull?: string;
  detailCode?: boolean;
  /** The box or the region of the diagram it stands for: its own box, or for an exit the shape whose row it is. */
  of: string;
  /** For an exit: the row of `of` it is, by index. */
  row?: number;
  /** For an exit: the returns and throws of the tree it ends at (DiagramRow.ends). */
  ends?: string[];
  /** For an exit: the code of the returns and throws it ends at, for its card. */
  exitCode?: string;
  /** The region it stands in, by id. */
  group?: string;
  width: number;
  height: number;
}

/** An arrow of the chart. */
export interface ChartEdge extends GraphEdge {
  /** The decision and the side the arrow is, when it is one. */
  side?: { node: string; side: string };
  /** The arrow leads to an exit (a terminal node). */
  exit?: boolean;
}

/** A region of the chart (a subgraph): the boxes of the body of a `try`, and their exits. */
export interface ChartGroup extends GraphGroup {
  /** `g:<the try's node id>`, as in the diagram. */
  id: string;
  /** Its title at the top: 例外を捕まえる範囲, and what an exception does when the catch ignores it. */
  title: string;
}

/** The nodes, arrows and regions of the chart of a frame. */
export interface Chart {
  /** The key of the diagram it draws. */
  key: string;
  nodes: ChartNode[];
  edges: ChartEdge[];
  groups: ChartGroup[];
}

/** What a step of an endpoint is, for the box that draws it and the arrows between steps. */
export type ChartStep = Pick<FlowStep, 'id' | 'kind' | 'consumes' | 'produces'>;

/** What the chart of a frame reads besides its diagram and its tree (see flowChart). */
export interface ChartOptions {
  /** What the words of the start come from (the JSDoc of the function a frame is). */
  words?: WordSource;
  /** The steps of the endpoint whose root the frame is, in their order: a step's box says what it reads and hands on, and the arrows between steps carry the values. */
  steps?: readonly ChartStep[];
  /** What the start says: the endpoint (`POST /token`); the frame's signature without it. */
  start?: string;
  /** A return of the frame answers the request (the root of an endpoint): its ends read 応答して終わる, else 返して終わる. */
  answers?: boolean;
}

/** How wide the text of a node draws: a title (13px, semibold), a title that is code (12px, the code font), a detail (11px), a detail that is code (11px, the code font). */
const TITLE_FONT: FontWidths = { wide: 13, narrow: 7.3 };
const CODE_FONT: FontWidths = { wide: 12, narrow: 7.25 };
const DETAIL_FONT: FontWidths = { wide: 11, narrow: 6.2 };
const DETAIL_CODE_FONT: FontWidths = { wide: 11, narrow: 6.65 };

/** The width of a box (a rounded rectangle) and of a rhombus, and the room between a box's edges and its lines. */
export const PROCESS_WIDTH = 300;
export const DECISION_WIDTH = 300;
export const NODE_INSET = 14;
/** The height of a box of one line and of two. */
const PROCESS_HEIGHT = 36;
const PROCESS_TALL = 52;
/** The height of a rhombus of one line and of two, and the room each line has inside it (the rhombus narrows away from its middle). */
const DECISION_HEIGHT = 62;
const DECISION_TALL = 80;
const DECISION_ROOM_ONE = 228;
const DECISION_ROOM_TWO = 178;
/** The least and the most width of a terminal (the start, an end, a failure), the room around its text, and its height of one line and of two. */
const TERMINAL_MIN = 132;
const TERMINAL_MAX = 300;
const START_MAX = 320;
const TERMINAL_PAD = 20;
const TERMINAL_HEIGHT = 34;
const TERMINAL_TALL = 48;

/** The room between the nodes of a rank, between parallel arrows, and between ranks: more air than the side pane's diagram, as Mermaid leaves. */
const SPACING = { node: 30, edge: 14, rank: 26 };

/** The room the title of a region takes at its top, from its border to its first node. */
export const GROUP_HEADER = 30;

/** Words as a line draws them: the code marks (`…`) left out, and the full stop at the end. */
function plain(text: string): string {
  return text.replace(/`/g, '').replace(/。$/, '');
}

/** Code on one line, the arguments of its calls shortened (`respondToken(…)`), for a detail line. */
function oneLine(code: string): string {
  const lines = code.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const first = compactArguments((lines[0] ?? '').replace(/\s+/g, ' '));
  return lines.length > 1 ? `${first} …` : first;
}

/** The values of a list of names, joined as an arrow's label or a detail line reads them. */
function names(values: readonly string[]): string {
  return values.join(', ');
}

/** What a step reads and hands on, on one line: `params, authorization → tokenClient`, `tokenResponse を読む`, `→ params`. */
export function stepValues(step: Pick<ChartStep, 'consumes' | 'produces'>): string {
  if (step.consumes.length > 0 && step.produces.length > 0) return `${names(step.consumes)} → ${names(step.produces)}`;
  if (step.consumes.length > 0) return `${names(step.consumes)} を読む`;
  if (step.produces.length > 0) return `→ ${names(step.produces)}`;
  return '';
}

/** The detail line of a step of an endpoint: its kind, and what it reads and hands on (`検証 · params, authorization → tokenClient`). */
export function stepDetail(step: ChartStep): string {
  const values = stepValues(step);
  return values === '' ? STEP_KIND_WORDS[step.kind] : `${STEP_KIND_WORDS[step.kind]} · ${values}`;
}

/** The step every node of a tree is in, by node id: the nearest step mark at or above it. */
function stepsOfNodes(nodes: readonly TreeNode[], into: Map<string, string> = new Map(), outer?: string): Map<string, string> {
  for (const node of nodes) {
    const step = node.step?.id ?? outer;
    if (step !== undefined) into.set(node.id, step);
    stepsOfNodes(node.pre ?? [], into, step);
    for (const branch of node.branches ?? []) stepsOfNodes(branch.nodes, into, step);
  }
  return into;
}

/** The condition of a decision as its rhombus reads it: its words, else its code without the keyword around it (`if (!client)` → `!client`). */
function conditionOf(box: DiagramNode, node: TreeNode): string {
  if (!box.titleCode) return box.title;
  const code = box.title.replace(/\s+/g, ' ').trim();
  const wrapped = /^(?:if|switch|while)\s*\((.*)\)$/.exec(code);
  if (wrapped !== null && (node.kind === 'if' || node.kind === 'switch' || node.kind === 'loop')) return wrapped[1] as string;
  return compactArguments(code);
}

/**
 * The lines of the condition of a rhombus: one line when it fits the widest
 * room of its middle, else up to two lines of the narrower room above and
 * below it, the second cut with an ellipsis.
 */
export function decisionLines(text: string, code: boolean): string[] {
  const font = code ? CODE_FONT : TITLE_FONT;
  if (textPixels(text, font) <= DECISION_ROOM_ONE) return [text];
  // wrapColumns counts a wide character as two columns; the font draws the others wider than half of one, so the columns
  // narrow until the first line fits its room in pixels, and only the last line is cut.
  for (let columns = Math.floor(DECISION_ROOM_TWO / (font.wide / 2)); columns >= 4; columns -= 1) {
    const lines = wrapColumns(text, columns, 2);
    if (lines.slice(0, -1).every((line) => textPixels(line, font) <= DECISION_ROOM_TWO)) return lines.map((line) => truncatePixels(line, DECISION_ROOM_TWO, font));
  }
  return [truncatePixels(text, DECISION_ROOM_ONE, font)];
}

/** The size and the lines of a terminal (the start, an end, a failure): as wide as its words, within its bounds. */
function terminal(title: string, detail: string | undefined, detailCode: boolean, most = TERMINAL_MAX): { width: number; height: number; line: string; detail?: string } {
  const detailFont = detailCode ? DETAIL_CODE_FONT : DETAIL_FONT;
  const natural = Math.max(textPixels(title, TITLE_FONT), detail === undefined ? 0 : textPixels(detail, detailFont)) + 2 * TERMINAL_PAD;
  const width = Math.ceil(Math.min(most, Math.max(TERMINAL_MIN, natural)));
  const room = width - 2 * TERMINAL_PAD;
  return { width, height: detail === undefined ? TERMINAL_HEIGHT : TERMINAL_TALL, line: truncatePixels(title, room, TITLE_FONT), ...(detail === undefined ? {} : { detail: truncatePixels(detail, room, detailFont) }) };
}

/** The node of a terminal of some words. */
function terminalNode(base: Pick<ChartNode, 'id' | 'shape' | 'of'> & Partial<ChartNode>, title: string, detail: string | undefined, detailCode: boolean, most?: number): ChartNode {
  const made = terminal(title, detail, detailCode, most);
  return {
    ...base,
    title,
    lines: [made.line],
    code: false,
    ...(detail === undefined || made.detail === undefined ? {} : { detail: made.detail, detailFull: detail, detailCode }),
    width: made.width,
    height: made.height,
  };
}

/** The words of an exit: what it returns or throws (`clientCredentialsResponse を返す`), from the words of its row after the arrow; a return with no words says what it returns (`return f(x)` → `f(x) を返す`). */
function exitWords(row: DiagramRow): string {
  const said = plain(row.full.replace(/^.*?→\s*/, '').replace(/^(?:終わり|失敗):\s*/, '').replace(/ ×\d+$/, ''));
  const value = /^return\b\s*(.*?);?$/.exec(said);
  if (value === null) return said;
  return value[1] === '' ? 'ここで終わる' : `${value[1] as string} を返す`;
}

/**
 * The title and the detail of the terminal of a row that fails: the error it
 * throws (`失敗: TokenError(invalid_client)`, `×n` when several throws throw
 * it), else how many throws and their errors, else what the row says.
 */
function failureWords(row: DiagramRow, errors: readonly string[]): { title: string; detail?: string } {
  const distinct = [...new Set(errors)];
  const count = row.ends.length > 1 ? ` ×${row.ends.length}` : '';
  if (distinct.length === 1) return { title: `失敗: ${distinct[0] as string}${count}` };
  if (distinct.length > 1) return { title: `失敗${count}`, detail: distinct.join('、') };
  return { title: `失敗${count}`, detail: exitWords(row) };
}

/**
 * The chart of a frame (see the module comment), from its diagram and its
 * tree: the options give the words of the start, the steps of the endpoint
 * whose root it is, and whether its returns answer the request.
 */
export function flowChart(diagram: Diagram, tree: FlowTree, options: ChartOptions = {}): Chart {
  const answers = options.answers === true;
  const stepById = new Map((options.steps ?? []).map((step) => [step.id, step]));
  const stepOrder = (options.steps ?? []).map((step) => step.id);
  const stepAt = stepsOfNodes(tree.nodes);
  const treeNode = (id: string | undefined): TreeNode | undefined => (id === undefined ? undefined : findNode(tree.nodes, id));
  const groupOf = new Map(diagram.groups.map((group) => [group.id, group]));
  const nodes: ChartNode[] = [];
  const edges: ChartEdge[] = [];
  const endWords = answers ? '応答して終わる' : '返して終わる';

  /** The side label of a decision's side, as the outline names it. */
  const labelOf = (side: { node: string; side: string }): string | undefined => {
    const decision = treeNode(side.node);
    const branch = decision?.branches?.find((candidate) => candidate.key === side.side);
    if (decision === undefined || branch === undefined) return undefined;
    return decision.kind === 'try' && side.side === 'catch' ? '例外' : sideLabel(decision, branch);
  };
  /** Whether a box is a decision the chart draws as a rhombus: a branching node with a side of its own (an arrow or an exit of a side). */
  const isRhombus = (box: DiagramNode, node: TreeNode | undefined): boolean => {
    if (node === undefined || !['if', 'switch', 'cond-expr', 'loop'].includes(node.kind)) return false;
    return box.rows.some((row) => row.side !== undefined) || diagram.edges.some((edge, index) => edge.from === box.id && diagram.sides.get(index)?.node === node.id);
  };

  // The nodes of the boxes, in the diagram's order.
  for (const box of diagram.nodes) {
    const node = treeNode(box.node);
    const group = box.group === undefined ? {} : { group: box.group };
    if (box.id === 'start') {
      const title = options.start ?? (tree.signature || tree.name);
      const summary = options.words?.functions[tree.id]?.summary;
      const detail = summary !== undefined && summary.trim() !== '' ? plain(firstSentence(summary)) : options.start !== undefined && tree.signature !== '' && tree.signature !== options.start ? tree.signature : undefined;
      nodes.push(terminalNode({ id: box.id, shape: 'start', of: box.id }, title, detail, detail === tree.signature, START_MAX));
      continue;
    }
    if (box.tone === 'end') {
      const said = box.titleCode ? box.title : plain(box.title);
      nodes.push(node?.kind === 'end' ? terminalNode({ id: box.id, shape: 'end', of: box.id, ...group }, said, undefined, false) : terminalNode({ id: box.id, shape: 'end', of: box.id, ...group }, endWords, said, box.titleCode));
      continue;
    }
    if (box.tone === 'error') {
      const title = node?.error !== undefined ? `失敗: ${node.error}` : node?.rethrow === true ? '失敗を投げ直す' : '失敗';
      const said = box.titleCode ? box.title : plain(box.title);
      const detail = node?.error !== undefined && said === `${node.error} を投げる` ? undefined : said;
      nodes.push(terminalNode({ id: box.id, shape: 'failure', of: box.id, ...group }, title, detail, box.titleCode));
      continue;
    }
    if (node !== undefined && isRhombus(box, node)) {
      const condition = conditionOf(box, node);
      const lines = decisionLines(condition, box.titleCode);
      nodes.push({ id: box.id, shape: 'decision', title: condition, lines, code: box.titleCode, of: box.id, ...group, width: DECISION_WIDTH, height: lines.length > 1 ? DECISION_TALL : DECISION_HEIGHT });
      continue;
    }
    const title = box.title.replace(/^[▸▾] /, '');
    // The box of a step (folded, or the heading of an open one) says the step's kind and values; a box inside it says its code.
    const facts = box.step === undefined || node?.step === undefined ? undefined : stepById.get(node.step.id);
    const code = oneLine(box.code);
    const detail = facts !== undefined ? stepDetail(facts) : !box.titleCode && code !== '' && code !== title ? code : undefined;
    const detailCode = facts === undefined;
    const room = PROCESS_WIDTH - 2 * NODE_INSET;
    nodes.push({
      id: box.id,
      shape: 'process',
      title,
      lines: [truncatePixels(title, room, box.titleCode ? CODE_FONT : TITLE_FONT)],
      code: box.titleCode,
      ...(detail === undefined ? {} : { detail: truncatePixels(detail, room, detailCode ? DETAIL_CODE_FONT : DETAIL_FONT), detailFull: detail, detailCode }),
      of: box.id,
      ...group,
      width: PROCESS_WIDTH,
      height: detail === undefined ? PROCESS_HEIGHT : PROCESS_TALL,
    });
  }

  // The arrows of the diagram, every one of them, with the values between steps.
  const boxById = new Map(diagram.nodes.map((box) => [box.id, box]));
  /** The step of the endpoint a box is in, when the frame has steps. */
  const stepOfBox = (id: string): ChartStep | undefined => {
    const box = boxById.get(id);
    const step = box?.node === undefined ? undefined : stepAt.get(box.node);
    return step === undefined ? undefined : stepById.get(step);
  };
  /** The values one step hands to the next: what it produces that the next or a later step consumes, else all it produces. */
  const handed = (from: ChartStep, to: ChartStep): { consumed: string[]; all: string[] } => {
    const later = new Set(stepOrder.slice(Math.max(0, stepOrder.indexOf(to.id))).flatMap((id) => stepById.get(id)?.consumes ?? []));
    return { consumed: from.produces.filter((name) => later.has(name)), all: [...from.produces] };
  };
  diagram.edges.forEach((edge, index) => {
    const side = diagram.sides.get(index);
    const made: ChartEdge = { from: edge.from, to: edge.to, kind: edge.kind, ...(side === undefined ? {} : { side }) };
    let label = side !== undefined ? (labelOf(side) ?? edge.label) : edge.label;
    // The arrow from a region into its catch is the way an exception takes.
    if (groupOf.has(edge.from) && edge.kind === 'error') label = '例外';
    const from = stepOfBox(edge.from);
    const to = stepOfBox(edge.to);
    if (from !== undefined && to !== undefined && from.id !== to.id) {
      const values = handed(from, to);
      if (label === undefined && (values.consumed.length > 0 || values.all.length > 0)) label = names(values.consumed.length > 0 ? values.consumed : values.all);
      else if (label !== undefined && values.consumed.length > 0) label = `${label} · ${names(values.consumed)}`;
    }
    if (label !== undefined && label !== '') made.label = label;
    edges.push(made);
  });

  // The exits: a terminal node a row of a box or of a region that ends the frame, with its labeled arrow.
  const exits: ChartNode[] = [];
  /** Add the exits of a box or a region, and label its other arrow with the side it is. */
  const addExits = (shape: DiagramNode | DiagramGroup, region: boolean) => {
    const own = region ? (shape as DiagramGroup).parent : (shape as DiagramNode).group;
    shape.rows.forEach((row, index) => {
      if (row.tone === 'pass') return;
      const id = `x:${shape.id}|${index}`;
      const exitCode = row.ends.map((end) => treeNode(end)?.code ?? '').filter((code) => code !== '').join('\n');
      const base = { id, shape: row.tone === 'error' ? ('failure' as const) : ('end' as const), of: shape.id, row: index, ends: [...row.ends], exitCode, ...(own === undefined ? {} : { group: own }) };
      const errors = row.ends.flatMap((end) => {
        const exit = treeNode(end);
        return exit?.kind === 'throw' && exit.error !== undefined ? [exit.error] : [];
      });
      const failure = failureWords(row, errors);
      const made = row.tone === 'error' ? terminalNode(base, failure.title, failure.detail, errors.length > 0) : terminalNode(base, endWords, exitWords(row), false);
      exits.push(made);
      const label = row.side !== undefined ? (labelOf(row.side) ?? '') : row.tone === 'error' ? '失敗' : answers ? '応答した' : '返した';
      edges.push({ from: shape.id, to: id, kind: region || row.tone === 'error' ? 'error' : 'branch', ...(label === '' ? {} : { label }), ...(row.side === undefined ? {} : { side: row.side }), exit: true });
    });
    if (region) return;
    // The box's own arrow on: the side it is, when its other sides are exits (a guard passed, a step that did not answer).
    const out = edges.filter((edge) => edge.from === shape.id && edge.exit !== true && edge.side === undefined);
    if (out.length !== 1 || shape.rows.length === 0) return;
    const decision = treeNode((shape as DiagramNode).node);
    // The sides some arrow or exit already is: the one left is the side this arrow is.
    const said = new Set(edges.filter((edge) => edge.from === shape.id && edge.side !== undefined).map((edge) => edge.side?.side));
    const rest = shape.rows.some((row) => row.side !== undefined) ? (decision?.branches ?? []).filter((branch) => branch.always !== true && !said.has(branch.key)) : [];
    const other = rest.length === 1 ? rest[0] : undefined;
    const answered = shape.rows.every((row) => row.side === undefined) && shape.rows.some((row) => row.tone === 'end');
    const words = other !== undefined && decision !== undefined ? sideLabel(decision, other) : answered ? (answers ? '応答なし' : '返さない') : undefined;
    const edge = out[0] as ChartEdge;
    if (words === undefined) return;
    edge.label = edge.label === undefined ? words : `${words} · ${edge.label}`;
    if (other !== undefined && decision !== undefined) edge.side = { node: decision.id, side: other.key };
  };
  for (const box of diagram.nodes) addExits(box, false);
  for (const group of diagram.groups) addExits(group, true);

  // The regions: each holds its boxes and the exits of its boxes, the exits first so its last member stays its last box (an arrow out of a region is laid out from it).
  const parents = new Map(diagram.groups.map((group) => [group.id, group.parent]));
  const within = (group: string | undefined, region: string): boolean => {
    for (let at = group; at !== undefined; at = parents.get(at)) if (at === region) return true;
    return false;
  };
  const groups: ChartGroup[] = diagram.groups.map((group) => {
    const pass = group.rows.some((row) => row.tone === 'pass');
    return {
      id: group.id,
      ...(group.parent === undefined ? {} : { parent: group.parent }),
      members: [...exits.filter((exit) => within(exit.group, group.id)).map((exit) => exit.id), ...group.members],
      title: pass ? `${group.title}（例外は無視して先へ）` : group.title,
    };
  });
  return { key: diagram.key, nodes: [...nodes, ...exits], edges, groups };
}

/** A placed chart: the layout of its nodes, regions and arrows (see layoutChart). */
export type ChartLayout = Layout;

/** A rectangle of the layout. */
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether two rectangles come closer than `pad` to each other. */
function overlaps(a: Area, b: Area, pad = 0): boolean {
  return a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;
}

/** The smallest rectangle that holds two, the second grown by `pad` on every side. */
function union(a: Area, b: Area, pad = 0): Area {
  const x = Math.min(a.x, b.x - pad);
  const y = Math.min(a.y, b.y - pad);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width + pad) - x, height: Math.max(a.y + a.height, b.y + b.height + pad) - y };
}

/** The rectangle of the label of an arrow. */
function labelArea(label: { x: number; y: number; width: number; height: number }): Area {
  return { x: label.x - label.width / 2, y: label.y - label.height / 2, width: label.width, height: label.height };
}

/** The corner of a rhombus an arrow meets it at: the top or the bottom one, else the side one the arrow comes from when it comes from the side. */
function corner(box: Area, toward: LayoutPoint, direction: LayoutDirection): LayoutPoint {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (direction === 'TB') {
    if (Math.abs(dx) > box.width / 2 && Math.abs(dy) < box.height) return { x: dx < 0 ? box.x : box.x + box.width, y: cy };
    return { x: cx, y: dy < 0 ? box.y : box.y + box.height };
  }
  if (Math.abs(dy) > box.height / 2 && Math.abs(dx) < box.width / 2) return { x: cx, y: dy < 0 ? box.y : box.y + box.height };
  return { x: dx < 0 ? box.x : box.x + box.width, y: cy };
}

/** The room kept around an exit placed beside its box, and between a region and what it newly holds. */
const EXIT_PAD = 10;
/** The least length of the arrow to an exit, and the room kept on each side of its label. */
const EXIT_ARROW = 40;
const EXIT_LABEL_ROOM = 12;
/** The margin of the canvas. */
const CANVAS_MARGIN = 12;

/** The path of a polyline. */
function pathOf(points: readonly LayoutPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
}

/** The ends of the straight arrow from a box or a region to an exit placed beside it or after it: from the side that faces the exit, in line with the exit's middle. */
function exitArrow(from: Area, exit: Area, direction: LayoutDirection): [LayoutPoint, LayoutPoint] {
  const middle = { x: exit.x + exit.width / 2, y: exit.y + exit.height / 2 };
  if (direction === 'TB') {
    if (exit.y >= from.y + from.height) return [{ x: middle.x, y: from.y + from.height }, { x: middle.x, y: exit.y }];
    const right = middle.x >= from.x + from.width / 2;
    return [{ x: right ? from.x + from.width : from.x, y: middle.y }, { x: right ? exit.x : exit.x + exit.width, y: middle.y }];
  }
  if (exit.x >= from.x + from.width) return [{ x: from.x + from.width, y: middle.y }, { x: exit.x, y: middle.y }];
  const down = middle.y >= from.y + from.height / 2;
  return [{ x: middle.x, y: down ? from.y + from.height : from.y }, { x: middle.x, y: down ? exit.y : exit.y + exit.height }];
}

/**
 * Lay out a chart. The flow without its exits is laid out by Dagre (see
 * layoutGraph), every node at its own size, every region with the room of its
 * title, and an arrow that meets a rhombus meets it at a corner. Then each
 * exit is put beside the box it leaves (to its right in a top-to-bottom
 * flow, below it in a left-to-right one; on the other side, or further out,
 * where that place is taken), at the box's height, so the main flow stays
 * one straight column and every way out reads next to where it leaves; the
 * exit of a region goes after it, in line with its last box, else beside its
 * end. A region grows to hold the exits of its boxes, never over a box that
 * is not its own. The arrow to an exit is straight, its label in the middle.
 */
export function layoutChart(chart: Chart, direction: LayoutDirection = 'TB'): ChartLayout {
  const byId = new Map(chart.nodes.map((node) => [node.id, node]));
  const flowNodes = chart.nodes.filter((node) => node.row === undefined);
  // The exits are left out of Dagre's layout: an arrow to a node it does not have is left out too, the indexes of the others kept.
  const placed = layoutGraph(flowNodes, chart.edges, new Set(chart.edges.map((_, index) => index)), direction, {
    width: (id) => byId.get(id)?.width ?? PROCESS_WIDTH,
    height: (id) => byId.get(id)?.height ?? PROCESS_HEIGHT,
    groups: chart.groups,
    header: () => GROUP_HEADER,
    spacing: SPACING,
  });
  const boxes = new Map<string, LayoutBox>(placed.boxes.map((box) => [box.id, { ...box }]));
  const groups = new Map<string, LayoutGroup>(placed.groups.map((group) => [group.id, { ...group }]));
  const arrows: LayoutArrow[] = placed.arrows.map((arrow) => {
    const edge = chart.edges[arrow.index] as ChartEdge;
    const points = arrow.points.map((point) => ({ ...point }));
    const source = byId.get(edge.from)?.shape === 'decision' ? boxes.get(edge.from) : undefined;
    const target = byId.get(edge.to)?.shape === 'decision' ? boxes.get(edge.to) : undefined;
    if (source !== undefined && points.length >= 2) points[0] = corner(source, points[1] as LayoutPoint, direction);
    if (target !== undefined && points.length >= 2) points[points.length - 1] = corner(target, points[points.length - 2] as LayoutPoint, direction);
    return { ...arrow, points, d: pathOf(points), ...(arrow.label === undefined ? {} : { label: { ...arrow.label } }) };
  });

  const parents = new Map(chart.groups.map((group) => [group.id, group.parent]));
  /** A region and the regions it is in, itself first. */
  const chainOf = (group: string | undefined): string[] => {
    const chain: string[] = [];
    for (let at = group; at !== undefined && !chain.includes(at); at = parents.get(at)) chain.push(at);
    return chain;
  };
  const regionOf = new Map(chart.nodes.map((node) => [node.id, node.group]));
  const tb = direction === 'TB';
  const exits: LayoutBox[] = [];
  /**
   * Whether an exit may stand at a place: it covers no box but its own, no
   * region it is not in, no label and no exit, and the regions it is in can
   * grow to hold it without covering a box or a region that is not theirs.
   */
  const free = (area: Area, exit: ChartNode): boolean => {
    const chain = chainOf(exit.group);
    for (const box of boxes.values()) if (box.id !== exit.of && overlaps(area, box, EXIT_PAD)) return false;
    for (const group of groups.values()) if (!chain.includes(group.id) && group.id !== exit.of && overlaps(area, group, EXIT_PAD)) return false;
    for (const arrow of arrows) if (arrow.label !== undefined && overlaps(area, labelArea(arrow.label), 4)) return false;
    for (const id of chain) {
      const region = groups.get(id);
      if (region === undefined) continue;
      const grown = union(region, area, EXIT_PAD + 2);
      for (const box of boxes.values()) if (!chainOf(regionOf.get(box.id)).includes(id) && overlaps(grown, box, 4)) return false;
      for (const group of groups.values()) if (!chainOf(group.id).includes(id) && !chain.includes(group.id) && overlaps(grown, group, 4)) return false;
    }
    return true;
  };
  chart.edges.forEach((edge, index) => {
    const exit = byId.get(edge.to);
    if (edge.exit !== true || exit === undefined) return;
    const from = boxes.get(edge.from) ?? groups.get(edge.from);
    if (from === undefined) return;
    const box = boxes.get(edge.from);
    // The arrow is long enough for its label: across it in a top-to-bottom flow, along it in a left-to-right one.
    const label = edge.label === undefined ? 0 : tb ? labelWidth(edge.label) : LABEL_HEIGHT;
    const gap = Math.max(EXIT_ARROW, label + 2 * EXIT_LABEL_ROOM);
    /** The place beside the box (or the end of the region) on a side (1: right or below, -1: left or above), `further` past the room the arrow needs. */
    const beside = (side: 1 | -1, further = 0): Area => {
      const middle = box !== undefined ? (tb ? from.y + from.height / 2 : from.x + from.width / 2) : tb ? from.y + from.height - exit.height / 2 - EXIT_PAD : from.x + from.width - exit.width / 2 - EXIT_PAD;
      if (tb) return { width: exit.width, height: exit.height, x: side === 1 ? from.x + from.width + gap + further : from.x - gap - further - exit.width, y: middle - exit.height / 2 };
      return { width: exit.width, height: exit.height, x: middle - exit.width / 2, y: side === 1 ? from.y + from.height + gap + further : from.y - gap - further - exit.height };
    };
    /** The place after a region along the flow, in line with its last box. */
    const after = (): Area => {
      const members = chart.groups.find((group) => group.id === edge.from)?.members ?? [];
      const last = [...members].reverse().map((id) => boxes.get(id)).find((item) => item !== undefined && byId.get(item.id)?.row === undefined);
      if (tb) return { width: exit.width, height: exit.height, x: (last === undefined ? from.x + from.width / 2 : last.x + last.width / 2) - exit.width / 2, y: from.y + from.height + gap };
      return { width: exit.width, height: exit.height, x: from.x + from.width + gap, y: (last === undefined ? from.y + from.height / 2 : last.y + last.height / 2) - exit.height / 2 };
    };
    const candidates: Area[] = [...(box === undefined ? [after()] : []), beside(1), beside(-1), ...Array.from({ length: 24 }, (_, step) => beside(step % 2 === 0 ? 1 : -1, 48 * (1 + Math.floor(step / 2))))];
    const area = candidates.find((candidate) => free(candidate, exit)) ?? (candidates[0] as Area);
    const made: LayoutBox = { id: exit.id, ...area };
    exits.push(made);
    boxes.set(exit.id, made);
    // The regions it is in grow to hold it, each with the regions inside it.
    for (const id of chainOf(exit.group)) {
      const region = groups.get(id);
      if (region === undefined) continue;
      let grown: Area = union(region, made, EXIT_PAD + 2);
      for (const inner of chart.groups.filter((group) => group.parent === id)) {
        const rect = groups.get(inner.id);
        if (rect !== undefined) grown = union(grown, rect, 8);
      }
      groups.set(id, { ...grown, id });
    }
    const [start, end] = exitArrow(from, made, direction);
    const points = [byId.get(edge.from)?.shape === 'decision' && box !== undefined ? corner(box, end, direction) : start, end];
    arrows.push({
      index,
      kind: edge.kind,
      d: pathOf(points),
      points,
      ...(edge.label === undefined ? {} : { label: { text: edge.label, x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, width: labelWidth(edge.label), height: LABEL_HEIGHT } }),
    });
  });

  // Everything moves so the canvas starts at its margin again, and the canvas grows to hold what the exits added.
  const all: Area[] = [...boxes.values(), ...groups.values(), ...arrows.flatMap((arrow) => (arrow.label === undefined ? [] : [labelArea(arrow.label)]))];
  const dx = CANVAS_MARGIN - Math.min(CANVAS_MARGIN, ...all.map((area) => area.x));
  const dy = CANVAS_MARGIN - Math.min(CANVAS_MARGIN, ...all.map((area) => area.y));
  const moved = <T extends Area>(area: T): T => ({ ...area, x: area.x + dx, y: area.y + dy });
  const outBoxes = [...placed.boxes.map((box) => moved(boxes.get(box.id) as LayoutBox)), ...exits.map(moved)];
  const outGroups = placed.groups.map((group) => moved(groups.get(group.id) as LayoutGroup));
  const outArrows = arrows
    .map((arrow) => {
      const points = arrow.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
      return { ...arrow, points, d: pathOf(points), ...(arrow.label === undefined ? {} : { label: { ...arrow.label, x: arrow.label.x + dx, y: arrow.label.y + dy } }) };
    })
    .sort((a, b) => a.index - b.index);
  const extent = [...outBoxes, ...outGroups, ...outArrows.flatMap((arrow) => (arrow.label === undefined ? [] : [labelArea(arrow.label)]))];
  const width = Math.max(placed.width + dx, ...extent.map((area) => area.x + area.width + CANVAS_MARGIN));
  const height = Math.max(placed.height + dy, ...extent.map((area) => area.y + area.height + CANVAS_MARGIN));
  return { width, height, boxes: outBoxes, groups: outGroups, arrows: outArrows };
}

/** The points of a rhombus in a box, for an SVG polygon: top, right, bottom, left. */
export function rhombusPoints(box: Pick<LayoutBox, 'x' | 'y' | 'width' | 'height'>): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return `${cx},${box.y} ${box.x + box.width},${cy} ${cx},${box.y + box.height} ${box.x},${cy}`;
}

/**
 * The way a request takes through the chart of a frame, read from the scenes
 * of a playback in that frame: the nodes it reaches (an exit included) with
 * the scenes that reach them, the arrows it travels with the scene that
 * travels each, and the exit each scene ends the frame at.
 */
export interface ChartWay {
  nodes: Map<string, number[]>;
  edges: Map<number, number>;
  exits: Map<number, string>;
}

/**
 * The way through a chart (see ChartWay) of the scenes in its frame. It
 * enters at the start, along the arrow from the start to its first scene. The
 * arrow between two scenes in a row is the arrow from the node of the first
 * to the node of the second, the one of the side the first one's decision
 * took when there are several; a scene ends at the exit of its node whose
 * returns or throws it reaches.
 */
export function chartWay(chart: Chart, scenes: readonly Scene[], frame: string): ChartWay {
  const way: ChartWay = { nodes: new Map(), edges: new Map(), exits: new Map() };
  const reach = (id: string, index: number) => way.nodes.set(id, [...(way.nodes.get(id) ?? []), index]);
  const travel = (edge: number, index: number) => {
    if (!way.edges.has(edge)) way.edges.set(edge, index);
  };
  let before: Scene | undefined;
  for (const scene of scenes) {
    if (scene.frame !== frame || scene.shape === undefined) continue;
    const at = scene.shape;
    if (before === undefined) {
      // The request comes into the frame at its start, and along the arrow from it to its first scene.
      reach('start', scene.index);
      const entry = chart.edges.findIndex((edge) => edge.from === 'start' && edge.to === at);
      if (entry !== -1) travel(entry, scene.index);
    }
    reach(at, scene.index);
    if (before !== undefined) {
      const from = before.shape;
      const candidates = chart.edges.flatMap((edge, index) => (edge.from === from && edge.to === at && edge.exit !== true ? [index] : []));
      const sides = before.stops.flatMap((stop) => (stop.side === undefined ? [] : [{ node: stop.node.id, side: stop.side.key }]));
      const chosen = candidates.find((index) => {
        const side = chart.edges[index]?.side;
        return side !== undefined && sides.some((taken) => taken.node === side.node && taken.side === side.side);
      }) ?? candidates[0];
      if (chosen !== undefined) travel(chosen, scene.index);
    }
    const ended = new Set(scene.stops.filter((stop) => stop.event === 'returns' || stop.event === 'throws').map((stop) => stop.node.id));
    const exit = chart.nodes.find((node) => node.of === at && node.row !== undefined && (node.ends ?? []).some((id) => ended.has(id)));
    if (exit !== undefined) {
      way.exits.set(scene.index, exit.id);
      reach(exit.id, scene.index);
      const edge = chart.edges.findIndex((candidate) => candidate.from === at && candidate.to === exit.id);
      if (edge !== -1) travel(edge, scene.index);
    }
    before = scene;
  }
  return way;
}

/** Where a node of the way stands at a scene: reached before it (the start always), the node of the scene, the exit the scene ends at, or still ahead. */
export type WayNodeState = 'visited' | 'current' | 'exit' | 'ahead';
/** Where an arrow of the way stands at a scene: travelled before it, travelled into the scene (or out of it to its exit), or still ahead. */
export type WayEdgeState = 'taken' | 'travel' | 'ahead';

/** The state of every node and arrow of a way at a scene (see WayNodeState, WayEdgeState); a node or an arrow off the way has none. */
export function wayAt(way: ChartWay, at: number): { nodes: Map<string, WayNodeState>; edges: Map<number, WayEdgeState> } {
  const exit = way.exits.get(at);
  const nodes = new Map<string, WayNodeState>();
  for (const [id, reached] of way.nodes) {
    // The start is where the request came in: it stays reached.
    nodes.set(id, id === 'start' ? 'visited' : id === exit ? 'exit' : reached.includes(at) ? 'current' : reached.some((index) => index < at) ? 'visited' : 'ahead');
  }
  const edges = new Map<number, WayEdgeState>();
  for (const [index, scene] of way.edges) edges.set(index, scene === at ? 'travel' : scene < at ? 'taken' : 'ahead');
  return { nodes, edges };
}
