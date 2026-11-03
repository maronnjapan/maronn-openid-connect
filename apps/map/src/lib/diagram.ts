/**
 * The diagram of one frame: its tree flattened into boxes and arrows, for the
 * reader who wants to see the shape of the flow. The outline of the trace
 * reads every statement; the diagram folds the tree the way the outline does
 * and draws the shape alone: where the flow splits and joins, where it ends,
 * and the way the choices take in blue. Nothing here touches the DOM.
 *
 * - A guard or an optional item is one box. The side of a guard, and any side
 *   that ends at once (a `catch` included), is a row inside the box of its
 *   decision: `成立 → return oauthError(…)`.
 * - The plain calls evaluated before a decision, a return or a throw are part
 *   of its box; a loop of one statement is one box; a run of actions is one.
 * - A step (the block a marker opens) is one box with its exits in a row,
 *   until the reader opens it in place. A step that holds a node the pull
 *   request changed is open until the reader folds it, and a changed node
 *   never folds into another box.
 * - The folds read the tree, the features that are on, the marks of the pull
 *   request and the steps the reader opened, never the choices, so a choice
 *   never moves a box.
 */
import type { Decisions, FlowTree, FrameChange, TreeNode } from '../types';
import { frameMark, nodeMark, strongest, type ChangeIndex, type Mark } from './changes';
import { compactArguments, wrapColumns, type GraphEdge, type GraphNode } from './graph';
import { branchesOf, chosenSide, decisionKey, findNode, forcedSide, nodesOn, nodesRun } from './trace';

/** A line inside a box below its title: a side of its decision that ends at once, or the exits of a folded step. */
export interface DiagramRow {
  /** The row as the box shows it: `→ return x`, `成立 → throw TokenError(…)`, `例外 → <the label of a step>`. */
  text: string;
  /** The row in full, for the tooltip: every exit a summary stands for. */
  full: string;
  /** end: the frame returns there; error: it throws there, or a catch takes it. */
  tone: 'end' | 'error';
  /** The decision and the side the row is; absent for the exits of a step. */
  side?: { node: string; side: string };
  /** The returns and throws the row ends with, by node: the row is on the chosen way when one of them runs. */
  ends: string[];
  /** The step the row names, by id: choosing the row opens the step in place. */
  step?: string;
}

/** How the box of a step is drawn. */
export interface DiagramStep {
  /** The id of the step's block, the key of DiagramOptions.toggled. */
  id: string;
  /** Drawn open: a heading box (`▾ <label>`) followed by the boxes of its body. */
  open: boolean;
  /** Choosing the box opens or folds the step in place; false for a folded step whose box opens the frame of its one call instead. */
  toggles: boolean;
}

/** A box of the diagram. */
export interface DiagramNode extends GraphNode {
  /** The first line of the box: a short name (`callee()`, the label of a step), else the code. */
  title: string;
  /** The second line: what the box does. */
  subtitle: string;
  /** The code of the box in full, for its tooltip. */
  code: string;
  tone: 'normal' | 'start' | 'end' | 'error';
  /** The node of the tree the box is (absent for the start). */
  node?: string;
  /** The rows inside the box, below its title. */
  rows: DiagramRow[];
  /** Every node of the tree the box stands for: its own, the calls and the sides folded into it, the inside of a folded step. */
  holds: string[];
  /** The function ids of the calls of the catalog among the nodes it holds. */
  calls: string[];
  /** The call whose frame choosing the box opens (the box of a call, a step that stands for one call), when the callee has a frame. */
  opens?: { node: string; fn: string };
  /** For the box of a step: how it is drawn. */
  step?: DiagramStep;
}

/** The boxes and arrows of a frame. */
export interface Diagram {
  /** Names the diagram (its frame), so the view resets when it changes; the same for every fold of the frame. */
  key: string;
  nodes: DiagramNode[];
  edges: GraphEdge[];
  /** For an arrow out of a decision: the decision and its side, by the index of the arrow. */
  sides: Map<number, { node: string; side: string }>;
}

/** What else the diagram of a frame folds by (see frameDiagram). */
export interface DiagramOptions {
  /** Whether the pull request changed a node (FrameChange.marks holds its id): such a node never folds into another box. */
  changed?: (id: string) => boolean;
  /** Whether a function has a frame the page can open: the box of a call of it opens that frame. */
  hasFrame?: (fn: string) => boolean;
  /** The steps the reader opened or folded, by id: each flips the default of its step (open when it holds a changed node, else folded). */
  toggled?: ReadonlySet<string>;
}

/** What choosing a box does: open the frame of its call, open or fold its step in place, select its row of the outline, or nothing (the start). */
export type BoxAction = 'open' | 'toggle' | 'select' | 'none';

interface Pending {
  from: string;
  label?: string;
  kind: GraphEdge['kind'];
  side?: { node: string; side: string };
}

/** The kinds of node that branch. */
const DECISION_KINDS: ReadonlySet<string> = new Set(['if', 'switch', 'loop', 'try', 'cond-expr']);

/** Whether a node ends the frame: a return outside a callback, or a throw. */
function isExit(node: TreeNode): boolean {
  return (node.kind === 'return' && node.local !== true) || node.kind === 'throw';
}

/** Whether a list ends the frame whatever its decisions choose, with the features that are on: the ends() of packages/map-analysis/src/tree.ts, which knows switch and try too. */
function ends(nodes: readonly TreeNode[], enabled: ReadonlySet<string> | undefined): boolean {
  return nodesOn(nodes, enabled).some((node) => endsNode(node, enabled));
}

/** Whether a node ends the frame whatever its decisions choose (see ends). */
function endsNode(node: TreeNode, enabled: ReadonlySet<string> | undefined): boolean {
  if (node.kind === 'return' || node.kind === 'throw') return isExit(node);
  if (node.kind === 'block') return ends(node.branches?.[0]?.nodes ?? [], enabled);
  if (node.kind !== 'if' && node.kind !== 'switch' && node.kind !== 'try') return false;
  // A feature that is off leaves the decision one side.
  if (forcedSide(node, enabled) !== undefined) return branchesOf(node, enabled).some((branch) => ends(branch.nodes, enabled));
  const branches = node.branches ?? [];
  if (node.kind === 'if') return branches.length === 2 && branches.every((branch) => ends(branch.nodes, enabled));
  if (node.kind === 'switch') {
    if (!branches.some((branch) => branch.key === 'default' || branch.label === 'default')) return false;
    return branches.every((branch, index) => ends(branch.nodes, enabled) || (branch.fallsThrough === true && index < branches.length - 1));
  }
  const attempt = branches.find((branch) => branch.key === 'try');
  const handler = branches.find((branch) => branch.key === 'catch');
  const final = branches.find((branch) => branch.key === 'finally');
  if (final !== undefined && ends(final.nodes, enabled)) return true;
  return attempt !== undefined && ends(attempt.nodes, enabled) && (handler === undefined || ends(handler.nodes, enabled));
}

/** The short name of a node for the title of its box: `callee()` for a call of a function or a member, the label for a step, else the code. */
function shortName(node: TreeNode): string {
  const target = node.target;
  if (node.kind === 'call' && (target?.kind === 'function' || target?.kind === 'member')) return `${target.id.slice(target.id.indexOf('#') + 1)}()`;
  if (node.kind === 'block' && node.step !== undefined) return node.step.label;
  return node.code;
}

/** Every node of a list and below it (its calls evaluated before, the sides of its decisions), the features ignored. */
function everyNode(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.pre ?? []), ...(node.branches ?? []).flatMap((branch) => everyNode(branch.nodes))]);
}

/**
 * The diagram of a frame (see the module comment): `enabled` narrows it to the
 * features that are on, and the options name the nodes the pull request
 * changed, the functions that have a frame and the steps the reader opened or
 * folded. A box is `n:<node>` (the first node of a run of actions); the start
 * is `start`.
 */
export function frameDiagram(tree: FlowTree, frame: string, enabled?: ReadonlySet<string>, options: DiagramOptions = {}): Diagram {
  const changed = options.changed ?? (() => false);
  const hasFrame = options.hasFrame ?? (() => false);
  const toggled = options.toggled ?? new Set<string>();
  const nodes: DiagramNode[] = [];
  const edges: GraphEdge[] = [];
  const sides = new Map<number, { node: string; side: string }>();

  const shown = (list: readonly TreeNode[]): TreeNode[] => nodesOn(list, enabled);
  /** The nodes of a list that are on, each followed by every node below it that is on. */
  const below = (list: readonly TreeNode[]): TreeNode[] => shown(list).flatMap((node) => [node, ...below(node.pre ?? []), ...branchesOf(node, enabled).flatMap((branch) => below(branch.nodes))]);
  const ids = (list: readonly TreeNode[]): string[] => below(list).map((node) => node.id);
  const holdsChange = (list: readonly TreeNode[]): boolean => below(list).some((node) => changed(node.id));
  const isStep = (node: TreeNode): boolean => node.kind === 'block' && node.step !== undefined;
  const openSteps = new Map<string, boolean>();
  /** A step is open when it holds a changed node, else folded; the reader's toggle flips that. */
  const isOpen = (node: TreeNode): boolean => {
    const known = openSteps.get(node.id);
    if (known !== undefined) return known;
    const open = holdsChange([node]) !== toggled.has(node.id);
    openSteps.set(node.id, open);
    return open;
  };
  /** The nodes of a list that are on and every node below them, the inside of a folded step left out. */
  const drawable = (list: readonly TreeNode[]): TreeNode[] =>
    shown(list).flatMap((node) => [node, ...(isStep(node) && !isOpen(node) ? [] : [...drawable(node.pre ?? []), ...branchesOf(node, enabled).flatMap((branch) => drawable(branch.nodes))])]);
  /** Whether a list can be a row: no decision and no open step in it but inside a folded step, and at most one folded step, which the row names. */
  const foldable = (list: readonly TreeNode[]): boolean => {
    const inside = drawable(list);
    return !inside.some((node) => DECISION_KINDS.has(node.kind) || (isStep(node) && isOpen(node))) && inside.filter(isStep).length <= 1;
  };
  /** The nodes of the true side of an `if` that are on. */
  const trueSide = (node: TreeNode): TreeNode[] => shown(branchesOf(node, enabled).find((branch) => branch.key === 'true')?.nodes ?? []);
  /** Whether an `if` is one box: a guard or an optional item the outline folds (neither it nor a node of its sides changed) whose true side a row can show. */
  const foldsIf = (node: TreeNode): boolean => {
    if (node.kind !== 'if' || (node.form !== 'guard' && node.form !== 'optional')) return false;
    if (changed(node.id) || branchesOf(node, enabled).some((branch) => branch.nodes.some((child) => changed(child.id)))) return false;
    return foldable(trueSide(node));
  };
  /** Whether a side ends at once (the analysis's rule for a guard: it ends, in at most three nodes) and can be a row: nothing in it changed. */
  const endsAtOnce = (list: readonly TreeNode[]): boolean => list.length > 0 && list.length <= 3 && ends(list, enabled) && !holdsChange(list) && foldable(list);
  /** What a side does, in order: its calls (`callee()`), the steps it goes through, and how it ends (`return x`). */
  const sideParts = (list: readonly TreeNode[]): string[] =>
    shown(list).flatMap((node) => {
      if (node.kind === 'call' || isStep(node)) return [shortName(node)];
      if (isExit(node)) return [node.code];
      return node.kind === 'block' ? sideParts(node.branches?.[0]?.nodes ?? []) : [];
    });
  /**
   * The row of a side that ends at once, naming the step it holds: a guard's
   * reads `→ <its calls>、<how it ends>`, any other `<label> → <how it ends>`
   * (a step's label when it ends in one); the full text names the calls too.
   */
  const sideRow = (node: TreeNode, side: string, list: readonly TreeNode[], label?: string): DiagramRow => {
    const exits = below(list).filter(isExit);
    const step = drawable(list).find(isStep);
    const parts = sideParts(list);
    const full = `${label === undefined ? '' : `${label} `}→ ${parts.join('、')}`;
    const text = label === undefined ? full : `${label} → ${parts[parts.length - 1] ?? ''}`;
    return { text, full, tone: exits.some((exit) => exit.kind === 'throw') ? 'error' : 'end', side: { node: node.id, side }, ends: exits.map((exit) => exit.id), ...(step === undefined ? {} : { step: step.id }) };
  };
  /** The row of a folded step: its exit, its exits `×n` when they read the same with the arguments left out, else how many ways it ends. */
  const exitsRow = (exits: readonly TreeNode[]): DiagramRow => {
    const codes = exits.map((exit) => exit.code);
    const compact = [...new Set(codes.map(compactArguments))];
    const text = codes.length === 1 ? `→ ${codes[0]}` : compact.length === 1 ? `→ ${compact[0]} ×${codes.length}` : `→ ${codes.length} 通りで終わる`;
    return { text, full: `→ ${codes.join('、')}`, tone: exits.every((exit) => exit.kind === 'throw') ? 'error' : 'end', ends: exits.map((exit) => exit.id) };
  };
  /**
   * The call a step stands for (a step of a Hono pipeline): the only call in
   * it, of a function, with no decision but guards and optional items that
   * fold, and on the step's own way: not on a side of one of those, such as
   * the call a guard returns on its way out.
   */
  const oneCall = (inside: readonly TreeNode[]): TreeNode | undefined => {
    const calls = inside.filter((node) => node.kind === 'call');
    if (calls.length !== 1 || inside.some((node) => DECISION_KINDS.has(node.kind) && !foldsIf(node))) return undefined;
    const onSides = new Set(inside.filter((node) => node.kind === 'if').flatMap((node) => branchesOf(node, enabled).flatMap((branch) => ids(branch.nodes))));
    return calls.find((call) => !onSides.has(call.id));
  };

  const connect = (entries: readonly Pending[], to: string) => {
    for (const entry of entries) {
      const edge: GraphEdge = { from: entry.from, to, kind: entry.kind };
      if (entry.label !== undefined) edge.label = entry.label;
      if (entry.side !== undefined) sides.set(edges.length, entry.side);
      edges.push(edge);
    }
  };
  /** Add the box of a node, holding the calls folded into it, with the arrows that lead to it. */
  const box = (node: TreeNode, entries: readonly Pending[], folded: readonly TreeNode[] = [], override: Partial<DiagramNode> = {}): DiagramNode => {
    const made: DiagramNode = {
      id: `n:${node.id}`,
      node: node.id,
      title: shortName(node),
      subtitle: node.text ?? '',
      code: node.code,
      tone: node.kind === 'throw' ? 'error' : node.kind === 'return' || node.kind === 'end' ? 'end' : 'normal',
      rows: [],
      holds: [node.id, ...folded.map((call) => call.id)],
      calls: [],
      ...override,
    };
    if (node.kind === 'call' && node.target?.kind === 'function' && hasFrame(node.target.id)) made.opens = { node: node.id, fn: node.target.id };
    nodes.push(made);
    connect(entries, made.id);
    return made;
  };

  const list = (items: readonly TreeNode[], entries: Pending[]): Pending[] => {
    let open = entries;
    const visible = shown(items);
    // A run of actions is one box; a changed action breaks it, as in the outline.
    const runs = (node: TreeNode | undefined): boolean => node !== undefined && node.kind === 'action' && node.pre === undefined && !changed(node.id);
    for (let index = 0; index < visible.length; index += 1) {
      const node = visible[index] as TreeNode;
      let end = index;
      while (runs(node) && runs(visible[end + 1])) end += 1;
      if (end > index) {
        const run = visible.slice(index, end + 1);
        const made = box(node, open, run.slice(1), { title: `処理 ×${run.length}`, subtitle: run.map((item) => item.code).join(' / '), code: run.map((item) => item.code).join('\n') });
        open = [{ from: made.id, kind: 'flow' }];
        index = end;
        continue;
      }
      open = one(node, open);
    }
    return open;
  };
  /** Draw a node after what is evaluated before it; returns the ways out of it. */
  const one = (node: TreeNode, entries: Pending[]): Pending[] => {
    let open = entries;
    const folded: TreeNode[] = [];
    // A plain call in the condition of a decision, in a return or in a throw is part of its box. The
    // arguments of that call, the arguments of any other call and a branching expression are boxes before it.
    const absorbs = DECISION_KINDS.has(node.kind) || node.kind === 'return' || node.kind === 'throw';
    for (const before of shown(node.pre ?? [])) {
      if (absorbs && before.kind === 'call' && before.branches === undefined && !changed(before.id)) {
        for (const argument of shown(before.pre ?? [])) open = one(argument, open);
        folded.push(before);
      } else open = one(before, open);
    }
    switch (node.kind) {
      case 'return':
      case 'throw': {
        const made = box(node, open, folded);
        return node.local === true ? [{ from: made.id, kind: 'flow' }] : [];
      }
      case 'block':
        if (node.step !== undefined) return step(node, open);
        return list(node.branches?.[0]?.nodes ?? [], [{ from: box(node, open).id, kind: 'flow' }]);
      case 'try':
        return attempt(node, open, folded);
      case 'loop':
        return loop(node, open, folded);
      case 'if':
      case 'switch':
      case 'cond-expr':
        return decision(node, open, folded);
      default: {
        const made = box(node, open, folded);
        return [{ from: made.id, kind: 'flow' }];
      }
    }
  };
  const step = (node: TreeNode, entries: Pending[]): Pending[] => {
    const label = node.step?.label ?? node.code;
    const body = node.branches?.[0]?.nodes ?? [];
    if (isOpen(node)) {
      const made = box(node, entries, [], { title: `▾ ${label}`, subtitle: '', step: { id: node.id, open: true, toggles: true } });
      return list(body, [{ from: made.id, kind: 'flow' }]);
    }
    const inside = below(body);
    // A step that holds a change opens in place, so the reader who folded it can open it again.
    const call = holdsChange([node]) ? undefined : oneCall(inside);
    const opens = call?.target?.kind === 'function' && hasFrame(call.target.id) ? { node: call.id, fn: call.target.id } : undefined;
    const made = box(node, entries, inside, { title: opens === undefined ? `▸ ${label}` : label, subtitle: '', step: { id: node.id, open: false, toggles: opens === undefined } });
    if (opens !== undefined) made.opens = opens;
    const exits = inside.filter(isExit);
    if (exits.length > 0) made.rows.push(exitsRow(exits));
    return ends(body, enabled) ? [] : [{ from: made.id, kind: 'flow' }];
  };
  const attempt = (node: TreeNode, entries: Pending[], folded: readonly TreeNode[]): Pending[] => {
    const made = box(node, entries, folded, { title: 'try', subtitle: '例外を捕まえる範囲' });
    const branches = branchesOf(node, enabled);
    const body = branches.find((branch) => branch.key === 'try');
    const handler = branches.find((branch) => branch.key === 'catch');
    const final = branches.find((branch) => branch.key === 'finally');
    let out = list(body?.nodes ?? [], [{ from: made.id, kind: 'flow' }]);
    if (handler !== undefined) {
      const caught = shown(handler.nodes);
      if (endsAtOnce(caught)) {
        // A catch that ends at once is a row, red as the arrow of the error it stands for.
        made.rows.push({ ...sideRow(node, handler.key, caught, '例外'), tone: 'error' });
        made.holds.push(...ids(caught));
      } else out = [...out, ...list(handler.nodes, [{ from: made.id, kind: 'error', label: '例外が起きたとき', side: { node: node.id, side: 'catch' } }])];
    }
    if (final !== undefined) out = list(final.nodes, out);
    return out;
  };
  const loop = (node: TreeNode, entries: Pending[], folded: readonly TreeNode[]): Pending[] => {
    const branches = branchesOf(node, enabled);
    const body = branches.find((branch) => branch.key === 'body');
    const inside = shown(body?.nodes ?? []);
    const only = inside[0];
    // A loop of one call or one action that decides nothing is one box, unless the pull request changed it.
    if (inside.length === 1 && only !== undefined && (only.kind === 'call' || only.kind === 'action') && only.branches === undefined && !below(inside).some((child) => DECISION_KINDS.has(child.kind)) && !changed(node.id) && !holdsChange(inside)) {
      const made = box(node, entries, folded, { subtitle: shortName(only), code: `${node.code}\n${only.code}` });
      made.holds.push(...ids(inside));
      return [{ from: made.id, kind: 'flow' }];
    }
    const made = box(node, entries, folded);
    const out = list(body?.nodes ?? [], [{ from: made.id, kind: 'branch', label: body?.label ?? '繰り返す', side: { node: node.id, side: 'body' } }]);
    const skip = branches.find((branch) => branch.key === 'skip');
    return [...out, ...(skip === undefined ? [] : [{ from: made.id, kind: 'branch' as const, label: skip.label, side: { node: node.id, side: 'skip' } }])];
  };
  const decision = (node: TreeNode, entries: Pending[], folded: readonly TreeNode[]): Pending[] => {
    const branches = branchesOf(node, enabled);
    if (foldsIf(node)) {
      const yes = trueSide(node);
      const made = box(node, entries, folded);
      made.holds.push(...ids(yes));
      const exits = node.form === 'guard' && ends(yes, enabled);
      if (exits) made.rows.push(sideRow(node, 'true', yes));
      else if (yes.length > 0) made.subtitle = `→ ${yes.map((child) => child.code).join('、')}`;
      // With its other side gone (a feature that is off), a guard ends here.
      return exits && branches.every((branch) => branch.key === 'true') ? [] : [{ from: made.id, kind: 'flow' }];
    }
    const made = box(node, entries, folded);
    // A side of a fork, a case or a side of an expression that ends at once is a row; an `if` that does not fold keeps its sides.
    const rows = node.kind !== 'if' || (node.form !== 'guard' && node.form !== 'optional');
    const out: Pending[] = [];
    for (const branch of branches) {
      const side = shown(branch.nodes);
      if (rows && branch.always !== true && endsAtOnce(side)) {
        made.rows.push(sideRow(node, branch.key, side, branch.label));
        made.holds.push(...ids(side));
        continue;
      }
      out.push(...list(branch.nodes, [{ from: made.id, kind: 'branch', label: branch.label, side: { node: node.id, side: branch.key } }]));
    }
    return out;
  };

  nodes.push({ id: 'start', title: tree.signature || tree.name, subtitle: '', code: tree.signature || tree.name, tone: 'start', rows: [], holds: [], calls: [] });
  list(tree.nodes, [{ from: 'start', kind: 'flow' }]);
  const byId = new Map(everyNode(tree.nodes).map((node) => [node.id, node]));
  const callee = (id: string): string[] => {
    const held = byId.get(id);
    return held?.kind === 'call' && held.target?.kind === 'function' ? [held.target.id] : [];
  };
  for (const made of nodes) made.calls = [...new Set(made.holds.flatMap(callee))];
  return { key: `frame:${tree.id}:${frame}`, nodes, edges, sides };
}

/**
 * The boxes, arrows and rows the choices run through: a box whose node runs,
 * an arrow between two such boxes on the chosen side, and a row
 * (`<box>|<index>`) one of whose exits runs.
 */
export function activeOf(diagram: Diagram, tree: FlowTree, frame: string, choices: readonly Decisions[], enabled?: ReadonlySet<string>): { nodes: Set<string>; edges: Set<number>; rows: Set<string> } {
  const run = nodesRun(tree, frame, choices, enabled);
  const nodes = new Set<string>(['start']);
  for (const node of diagram.nodes) if (node.node !== undefined && run.has(node.node)) nodes.add(node.id);
  const edges = new Set<number>();
  diagram.edges.forEach((edge, index) => {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
    const side = diagram.sides.get(index);
    if (side !== undefined) {
      const treeNode = findNode(tree.nodes, side.node);
      const chosen = (treeNode === undefined ? undefined : forcedSide(treeNode, enabled)) ?? chosenSide(choices, decisionKey(frame, side.node));
      if (chosen !== undefined && chosen !== side.side) return;
    }
    edges.add(index);
  });
  const rows = new Set<string>();
  for (const node of diagram.nodes) {
    node.rows.forEach((row, index) => {
      if (row.ends.some((id) => run.has(id))) rows.add(`${node.id}|${index}`);
    });
  }
  return { nodes, edges, rows };
}

/** The box that shows a node of the tree: the box that holds it, else the box of its nearest ancestor that one holds; undefined when none does. */
export function boxOf(diagram: Diagram, node: string): DiagramNode | undefined {
  const box = diagram.nodes.find((candidate) => candidate.holds.includes(node));
  if (box !== undefined) return box;
  // An id is the id of the node it is under and its place there (`s0b1s0` under `s0b1`, `s5i0` under `s5`).
  const parent = node.replace(/[a-z]+[0-9]+$/, '');
  return parent === node || parent === '' ? undefined : boxOf(diagram, parent);
}

/**
 * The height of a box at a width, with a badge of `badgeWidth` at the right
 * of its first line: its title in at most two lines (7px a column), the
 * subtitle when the title takes one line, and 16px a row; at least 36px. The
 * start is 36px.
 */
export function boxHeight(node: DiagramNode, width: number, badgeWidth = 0): number {
  if (node.tone === 'start') return 36;
  const lines = wrapColumns(node.title, Math.floor((width - 24 - badgeWidth) / 7), 2).length;
  const subtitle = lines === 1 && node.subtitle !== '' ? 15 : 0;
  return Math.max(36, 16 + 17 * lines + subtitle + 16 * node.rows.length);
}

/** What choosing a box does (see BoxAction): a box that opens a frame opens it, a step that toggles or is open toggles, any other box of a node selects its row. */
export function boxAction(box: DiagramNode): BoxAction {
  if (box.opens !== undefined) return 'open';
  if (box.step !== undefined && (box.step.open || box.step.toggles)) return 'toggle';
  return box.node === undefined ? 'none' : 'select';
}

/** The lines that describe a box or a row read as one label (its aria-label): a sentence a line, joined with '。', the full stop a line ends with (`。`, `.`) taking the place of the one between. */
export function spokenLabel(lines: readonly string[]): string {
  return lines.map((line) => line.replace(/[。．.]$/, '')).join('。');
}

/** The badge of a box: the strongest of the badges of the nodes it holds (the change of the frame) and of the frames its calls lead to. */
export function markOfBox(box: DiagramNode, change: FrameChange | undefined, changes: ChangeIndex | undefined): Mark | undefined {
  return strongest([...box.holds.map((id) => nodeMark(change, id)), ...box.calls.map((fn) => frameMark(changes, fn))]);
}
