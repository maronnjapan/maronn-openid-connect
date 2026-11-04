/**
 * The diagram of one frame: its tree flattened into boxes and arrows, for the
 * reader who wants to see the shape of the flow. The outline of the trace
 * reads every statement; the diagram folds the tree the way the outline does
 * and draws the shape alone: where the flow splits and joins, where it ends,
 * and the way the choices take in blue. Nothing here touches the DOM.
 *
 * - Every box is one line, read at a glance: what it does in words (the
 *   label of a step, the JSDoc of what a call reaches, the comment above a
 *   statement; see words.ts), else its code, and at its end how it ends the
 *   flow there (`→ 終わり`, `→ 失敗 ×2`). The code, the whole text and every
 *   row in full are the box's card.
 * - A guard or an optional item is one box. The side of a guard, and any side
 *   that ends at once, is a row of the box of its decision: a tag of its line.
 * - The plain calls evaluated before a decision, a return or a throw are part
 *   of its box; a loop of one statement is one box; statements in a row that
 *   say nothing in words (variables, settings) are one box, read as the
 *   outline reads them (`a、b を用意する`, see runWords).
 * - A step (the block a marker opens) is one box with its exits as tags,
 *   until the reader opens it in place. A step that holds a node the pull
 *   request changed is open until the reader folds it, and a changed node
 *   never folds into another box. A trace passes the outline's rules instead
 *   (DiagramOptions.stepOpen, stepCall, foldsGuard), so the two views fold
 *   the same steps and guards the same way.
 * - The card of a box offers to look inside every call it holds that the
 *   outline can open: its own, the calls evaluated for its condition or its
 *   return, the calls of a side folded into it; never the inside of a folded
 *   step, which opens in place first.
 * - A `try` is no box: the boxes of its body stand inside a region, whose
 *   label says what an exception does there. A catch that ends at once, or
 *   does nothing, is a row of the region (`→ 例外: 失敗`); any other catch is
 *   drawn after the region, entered by a red dashed arrow that leaves it.
 * - The folds of the default rules read the tree, the features that are on,
 *   the marks of the pull request and the steps the reader opened, never the
 *   choices, so a choice never moves a box; the outline's rules a trace
 *   passes also open a step that holds a choice or an opened frame, as the
 *   outline does.
 */
import type { Decisions, FlowTree, FrameChange, TreeNode } from '../types';
import { heldMarks, type ChangeIndex, type Mark } from './changes';
import { layoutGraph, textPixels, truncatePixels, type FontWidths, type GraphEdge, type GraphGroup, type GraphNode, type LayoutDirection } from './graph';
import { branchesOf, chosenSide, decisionKey, findNode, forcedSide, nodesOn, nodesRun } from './trace';
import { firstSentence, nodeWords, runWords, sideWords, splitPre, type WordSource, type Words } from './words';

/** A way a box or a region ends the flow, or lets it go on: a side of its decision that ends at once, the exits of a folded step, or a catch that does nothing. */
export interface DiagramRow {
  /** The row in full, for the card: the side, then what it does and how it ends, in words (`成立 → 終わり: トークンを返す`). */
  full: string;
  /** end: the frame returns there; error: it throws there; pass: the flow goes on past the decision (a catch that ignores the exception). */
  tone: 'end' | 'error' | 'pass';
  /** The decision and the side the row is; absent for the exits of a step. */
  side?: { node: string; side: string };
  /** The returns and throws the row ends with, by node: the row is on the chosen way when one of them runs. */
  ends: string[];
  /** The step the row names, by id: the card offers to open it in place. */
  step?: string;
}

/** How the box of a step is drawn. */
export interface DiagramStep {
  /** The id of the step's block, the key of DiagramOptions.toggled. */
  id: string;
  /** Drawn open: a heading box (`▾ <label>`) followed by the boxes of its body. */
  open: boolean;
  /** The card offers to open or fold the step in place; false for a folded step that stands for its one call, whose card opens that call's frame instead. */
  toggles: boolean;
}

/** A box of the diagram. */
export interface DiagramNode extends GraphNode {
  /** The words of the box's one line: what it does (the label of a step, the JSDoc sentence of what a call reaches, the comment above it), else its code; a step the card can open or fold starts with ▸ or ▾. */
  title: string;
  /** The title is code, not words: it is drawn in the code font. */
  titleCode: boolean;
  /** The code of the box in full, for its card; '' for the heading of an open step. */
  code: string;
  /** What the box does in full, for its card: the whole JSDoc or comment its title is the first sentence of; absent when the title is code. */
  text?: string;
  tone: 'normal' | 'start' | 'end' | 'error';
  /** The node of the tree the box is (absent for the start). */
  node?: string;
  /** How the box ends the flow besides its own exit, drawn as tags at the end of its line. */
  rows: DiagramRow[];
  /** Every node of the tree the box stands for: its own, the calls and the sides folded into it, the inside of a folded step. */
  holds: string[];
  /** What the calls among the nodes it holds reach: functions of the catalog and members of interfaces, by id (its badge reads them, see heldMarks). */
  calls: string[];
  /** The call whose frame the card offers to open first, when the callee has a frame: the box of a call, a step that stands for one call, the call its condition or its return speaks for. */
  opens?: { node: string; fn: string };
  /** The other calls whose frames the card offers to open, in the order they run: the other calls evaluated before its node, the calls of a side folded into it (with the index of the row that side is, when it is one). */
  alsoOpens?: Array<{ node: string; fn: string; row?: number }>;
  /** For the box of a step: how it is drawn. */
  step?: DiagramStep;
  /** The region (DiagramGroup) the box is directly inside, by id. */
  group?: string;
}

/** A region: the boxes of the body of a `try`, drawn inside a dashed border with a one-line label at its top that says what an exception does. */
export interface DiagramGroup extends GraphGroup {
  /** `g:<the try's node id>`. */
  id: string;
  /** The `try`, by its id in the tree. */
  node: string;
  /** The region it is inside, by id. */
  parent?: string;
  /** Every box it encloses, by id, those of the regions inside it included, in the order they are drawn. */
  members: string[];
  /** The words its label starts with: 例外を捕まえる範囲. */
  title: string;
  /** What its catch does when the label says it: it ends at once (`例外 → 終わり: …`), or it ignores the exception (tone pass). */
  rows: DiagramRow[];
  /** What happens to an exception, in full, for its card. */
  outcome: string;
  /** The code of the `try`, for its card. */
  code: string;
  /** Every node it stands for besides its boxes: the `try`, and the nodes of a catch that is a row. */
  holds: string[];
  /** What the calls among the nodes it holds reach: functions of the catalog and members of interfaces, by id. */
  calls: string[];
}

/** The boxes, regions and arrows of a frame. */
export interface Diagram {
  /** Names the diagram (its frame), so the view resets when it changes; the same for every fold of the frame. */
  key: string;
  nodes: DiagramNode[];
  /** The arrows between boxes; the red arrow into a catch leaves from its region (an edge from a DiagramGroup's id). */
  edges: GraphEdge[];
  /** For an arrow out of a decision: the decision and its side, by the index of the arrow. */
  sides: Map<number, { node: string; side: string }>;
  /** The regions of the tries, each before the regions inside it. */
  groups: DiagramGroup[];
}

/** What else the diagram of a frame folds by (see frameDiagram). */
export interface DiagramOptions {
  /** Whether the pull request changed a node (FrameChange.marks holds its id): such a node never folds into another box. */
  changed?: (id: string) => boolean;
  /** Whether a function has a frame the page can open: the card of a box that calls it offers to open that frame. */
  hasFrame?: (fn: string) => boolean;
  /** The steps the reader opened or folded, by id: each flips the default of its step (open when it holds a changed node, else folded); stepOpen, when given, decides instead. */
  toggled?: ReadonlySet<string>;
  /** What the words of the boxes come from (the JSDoc of the functions and members of the map, MapData); without it a box reads the words its node keeps, else its code. */
  words?: WordSource;
  /**
   * Whether a step that does not stand for one call (see stepCall) is drawn
   * open: replaces the default and `toggled` when given. A trace passes the
   * outline's rule, the reader's toggle included (stepHolds in trace.ts: open
   * for a change, an opened frame or a choice).
   */
  stepOpen?: (step: TreeNode) => boolean;
  /**
   * The one call a step stands for, drawn as one box that opens that call's
   * frame, else undefined: replaces the default (the only call of a folded
   * step besides guards that fold, see oneCall) when given. A trace passes
   * the outline's rule (stepCall in trace.ts).
   */
  stepCall?: (step: TreeNode) => TreeNode | undefined;
  /**
   * Whether a guard or an optional item (an `if` of form guard or optional)
   * folds into one box: replaces the default (neither it nor a node of its
   * sides changed) when given. A trace passes the outline's rule (foldsGuard
   * in trace.ts). A row cannot draw a decision or an open step, so a true
   * side that holds one is drawn in full whatever it says.
   */
  foldsGuard?: (node: TreeNode) => boolean;
}

/** What the card of a box or a region offers besides selecting it: look inside the function a box calls, or open or fold a step in place (the box's own, or one a row names); an action of a row goes with that row. */
export type CardAction =
  | { kind: 'open'; node: string; fn: string; name: string; row?: number }
  | { kind: 'toggle'; step: string; open: boolean; row?: number };

interface Pending {
  from: string;
  label?: string;
  kind: GraphEdge['kind'];
  side?: { node: string; side: string };
}

/** The kinds of node that branch. */
const DECISION_KINDS: ReadonlySet<string> = new Set(['if', 'switch', 'loop', 'try', 'cond-expr']);

/** No words to read beyond what the tree keeps. */
const NO_WORDS: WordSource = { functions: {}, members: {} };

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

/** Every node of a list and below it (its calls evaluated before, the sides of its decisions), the features ignored. */
function everyNode(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.pre ?? []), ...(node.branches ?? []).flatMap((branch) => everyNode(branch.nodes))]);
}

/** Words as a line of the diagram draws them: the code marks (`…`) left out, and the full stop at the end, which a cut line has no room for. */
function plain(text: string): string {
  return text.replace(/`/g, '').replace(/。$/, '');
}

/** Whether a statement says nothing in words: an action with no comment above it, whose code is all its box could show (the outline's rule, trace.ts). */
function silent(node: TreeNode): boolean {
  return node.kind === 'action' && node.branches === undefined && (node.pre ?? []).length === 0 && !(node.text !== undefined && (node.from === 'comment' || node.from === 'doc'));
}

/** The lines of code a card shows for the statements of a list: at most six, then how many more. */
function codeLines(nodes: readonly TreeNode[]): string {
  const lines = nodes.map((node) => node.code);
  return lines.length <= 6 ? lines.join('\n') : `${lines.slice(0, 6).join('\n')}\n…（ほか ${lines.length - 6} 行）`;
}

/**
 * The diagram of a frame (see the module comment): `enabled` narrows it to the
 * features that are on, and the options name the nodes the pull request
 * changed, the functions that have a frame, the steps the reader opened or
 * folded, where the words come from, and the rules of the outline to fold
 * the steps and the guards by (see DiagramOptions). A box is `n:<node>` (the
 * first node of a run of actions); the start is `start`; a region is
 * `g:<the try>`.
 */
export function frameDiagram(tree: FlowTree, frame: string, enabled?: ReadonlySet<string>, options: DiagramOptions = {}): Diagram {
  const changed = options.changed ?? (() => false);
  const hasFrame = options.hasFrame ?? (() => false);
  const toggled = options.toggled ?? new Set<string>();
  const source = options.words ?? NO_WORDS;
  const nodes: DiagramNode[] = [];
  const edges: GraphEdge[] = [];
  const sides = new Map<number, { node: string; side: string }>();
  const groups: DiagramGroup[] = [];
  // The regions being drawn, the innermost last.
  const regions: DiagramGroup[] = [];

  const shown = (list: readonly TreeNode[]): TreeNode[] => nodesOn(list, enabled);
  /** The nodes of a list that are on, each followed by every node below it that is on. */
  const below = (list: readonly TreeNode[]): TreeNode[] => shown(list).flatMap((node) => [node, ...below(node.pre ?? []), ...branchesOf(node, enabled).flatMap((branch) => below(branch.nodes))]);
  const ids = (list: readonly TreeNode[]): string[] => below(list).map((node) => node.id);
  const holdsChange = (list: readonly TreeNode[]): boolean => below(list).some((node) => changed(node.id));
  const isStep = (node: TreeNode): boolean => node.kind === 'block' && node.step !== undefined;
  const openSteps = new Map<string, boolean>();
  /** Whether a step is open unless it stands for one call: options.stepOpen, else open when it holds a changed node and folded otherwise, the reader's toggle flipping that. */
  const opensByRule = (node: TreeNode): boolean => {
    const known = openSteps.get(node.id);
    if (known !== undefined) return known;
    const open = options.stepOpen !== undefined ? options.stepOpen(node) : holdsChange([node]) !== toggled.has(node.id);
    openSteps.set(node.id, open);
    return open;
  };
  const stepCalls = new Map<string, TreeNode | undefined>();
  /** The call a step stands for (see DiagramOptions.stepCall): options.stepCall, else the only call of a step that is folded and holds no change (see oneCall); undefined for any other step. */
  const callOfStep = (node: TreeNode): TreeNode | undefined => {
    if (stepCalls.has(node.id)) return stepCalls.get(node.id);
    const call = options.stepCall !== undefined ? options.stepCall(node) : opensByRule(node) || holdsChange([node]) ? undefined : oneCall(below(node.branches?.[0]?.nodes ?? []));
    stepCalls.set(node.id, call);
    return call;
  };
  /** A step is drawn open by its rule (see opensByRule), unless it stands for one call, whose box it is. */
  const isOpen = (node: TreeNode): boolean => callOfStep(node) === undefined && opensByRule(node);
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
  /** Whether an `if` is one box: a guard or an optional item that folds (options.foldsGuard, else neither it nor a node of its sides changed) whose true side a row can show. */
  const foldsIf = (node: TreeNode): boolean => {
    if (node.kind !== 'if' || (node.form !== 'guard' && node.form !== 'optional')) return false;
    if (options.foldsGuard !== undefined ? !options.foldsGuard(node) : changed(node.id) || branchesOf(node, enabled).some((branch) => branch.nodes.some((child) => changed(child.id)))) return false;
    return foldable(trueSide(node));
  };
  /** Whether a node is a call of a function with a frame: the card of the box that holds it can offer to look inside. */
  const opensFrame = (node: TreeNode): node is TreeNode & { target: { kind: 'function'; id: string } } => node.kind === 'call' && node.target?.kind === 'function' && hasFrame(node.target.id);
  /** Whether the card of a folded step opens or folds it in place: any step but one that stands for its call and holds nothing else, whose card opens that call's frame instead. */
  const stepToggles = (node: TreeNode): boolean => {
    const call = callOfStep(node);
    return call === undefined || !opensFrame(call) || below(node.branches?.[0]?.nodes ?? []).some((item) => item !== call);
  };
  /** The calls of a list whose frames the outline can open, each a row of its own there or the row of what it is evaluated for: the calls of functions with a frame among its nodes and below them, the call of a step that stands for one, the inside of a folded step left out. */
  const callsToOpen = (list: readonly TreeNode[], row?: number): NonNullable<DiagramNode['alsoOpens']> =>
    drawable(list).flatMap((node) => {
      const call = isStep(node) && !isOpen(node) ? callOfStep(node) : node;
      return call !== undefined && opensFrame(call) ? [{ node: call.id, fn: call.target.id, ...(row === undefined ? {} : { row }) }] : [];
    });
  /** Let the card of a box offer to look inside more calls, each once. */
  const offer = (made: DiagramNode, more: NonNullable<DiagramNode['alsoOpens']>) => {
    const fresh = more.filter((item) => item.node !== made.opens?.node && !(made.alsoOpens ?? []).some((known) => known.node === item.node));
    if (fresh.length > 0) made.alsoOpens = [...(made.alsoOpens ?? []), ...fresh];
  };
  /** Whether a side ends at once (the analysis's rule for a guard: it ends, in at most three nodes) and can be a row: nothing in it changed. */
  const endsAtOnce = (list: readonly TreeNode[]): boolean => list.length > 0 && list.length <= 3 && ends(list, enabled) && !holdsChange(list) && foldable(list);
  /** The words of a side, as a line of the diagram draws them. */
  const sideLine = (list: readonly TreeNode[]): string => plain(sideWords(shown(list), source));
  /** The row of a side that ends at once (`成立 → 終わり: …`), naming the step it holds when the card can open it in place: red when it throws. */
  const sideRow = (node: TreeNode, side: string, list: readonly TreeNode[], label: string): DiagramRow => {
    const exits = below(list).filter(isExit);
    const step = drawable(list).find((item) => isStep(item) && stepToggles(item));
    return { full: `${label} → ${sideWords(shown(list), source)}`, tone: exits.some((exit) => exit.kind === 'throw') ? 'error' : 'end', side: { node: node.id, side }, ends: exits.map((exit) => exit.id), ...(step === undefined ? {} : { step: step.id }) };
  };
  /** The rows of the exits of a folded step: its returns, then its throws, each in words, `×n` for several that read the same. */
  const exitRows = (exits: readonly TreeNode[]): DiagramRow[] =>
    (['return', 'throw'] as const).flatMap((kind) => {
      const some = exits.filter((exit) => exit.kind === kind);
      if (some.length === 0) return [];
      const said = some.map((exit) => sideWords([exit], source));
      const counted = [...new Set(said)].map((words) => {
        const count = said.filter((other) => other === words).length;
        return count === 1 ? words : `${words} ×${count}`;
      });
      return [{ full: `→ ${counted.join('、')}`, tone: kind === 'throw' ? ('error' as const) : ('end' as const), ends: some.map((exit) => exit.id) }];
    });
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
  /** The whole text the words of a node are the first sentence of: the JSDoc of what it (or the call its box folds in) reaches, or the comment above it; undefined for code. */
  const wholeText = (node: TreeNode, said: Words, call: TreeNode | undefined): string | undefined => {
    if (said.code) return undefined;
    const target = (node.kind === 'call' ? node : call)?.target;
    const summary = target?.kind === 'function' ? source.functions[target.id]?.summary : target?.kind === 'member' ? source.members[target.id]?.summary : undefined;
    return [node.text, summary].find((text) => text !== undefined && firstSentence(text) === said.text) ?? said.text;
  };

  const connect = (entries: readonly Pending[], to: string) => {
    for (const entry of entries) {
      const edge: GraphEdge = { from: entry.from, to, kind: entry.kind };
      if (entry.label !== undefined) edge.label = entry.label;
      if (entry.side !== undefined) sides.set(edges.length, entry.side);
      edges.push(edge);
    }
  };
  /**
   * Add the box of a node, holding the calls folded into it, with the arrows
   * that lead to it; its words speak for the call evaluated last before it
   * when that is folded in. Its card opens the frame of its own call, else of
   * the call it speaks for, and of the other calls folded into it (not the
   * inside of a step, which it folds whole). A return in a callback ends no
   * frame: it is no end.
   */
  const box = (node: TreeNode, entries: readonly Pending[], folded: readonly TreeNode[] = [], override: Partial<DiagramNode> = {}): DiagramNode => {
    const last = splitPre(node).call;
    const call = last !== undefined && folded.includes(last) ? last : undefined;
    const said = nodeWords(node, source, call);
    const text = wholeText(node, said, call);
    const region = regions[regions.length - 1];
    const made: DiagramNode = {
      id: `n:${node.id}`,
      node: node.id,
      title: said.code ? said.text : plain(said.text),
      titleCode: said.code,
      code: node.code,
      ...(text === undefined ? {} : { text }),
      tone: node.kind === 'throw' ? 'error' : (node.kind === 'return' && node.local !== true) || node.kind === 'end' ? 'end' : 'normal',
      rows: [],
      holds: [node.id, ...folded.map((item) => item.id)],
      calls: [],
      ...(region === undefined ? {} : { group: region.id }),
      ...override,
    };
    const own = node.kind === 'call' ? node : call;
    if (own !== undefined && opensFrame(own)) made.opens = { node: own.id, fn: own.target.id };
    if (node.kind !== 'block') offer(made, folded.filter(opensFrame).map((item) => ({ node: item.id, fn: item.target.id })));
    nodes.push(made);
    connect(entries, made.id);
    return made;
  };

  const list = (items: readonly TreeNode[], entries: Pending[]): Pending[] => {
    let open = entries;
    const visible = shown(items);
    // Statements in a row that say nothing in words are one box, read in words; a changed one breaks the run, as in the outline.
    const runs = (node: TreeNode | undefined): boolean => node !== undefined && silent(node) && !changed(node.id);
    for (let index = 0; index < visible.length; index += 1) {
      const node = visible[index] as TreeNode;
      let end = index;
      while (runs(node) && runs(visible[end + 1])) end += 1;
      if (end > index) {
        const run = visible.slice(index, end + 1);
        const said = runWords(run);
        const made = box(node, open, run.slice(1), { title: plain(said.text), titleCode: said.code, code: run.map((item) => item.code).join('\n'), text: said.text });
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
    // A try has no condition: what is evaluated before it goes before its region.
    const absorbs = (DECISION_KINDS.has(node.kind) && node.kind !== 'try') || node.kind === 'return' || node.kind === 'throw';
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
        return attempt(node, open);
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
    const label = nodeWords(node, source).text;
    const body = node.branches?.[0]?.nodes ?? [];
    if (isOpen(node)) {
      const made = box(node, entries, [], { title: `▾ ${label}`, titleCode: false, code: '', step: { id: node.id, open: true, toggles: true } });
      return list(body, [{ from: made.id, kind: 'flow' }]);
    }
    const inside = below(body);
    // A step that holds a change opens in place, so the reader who folded it can open it again; so does a step of one call
    // whose box hides more than that call (the default rule, see oneCall), so every row of the outline can have its box.
    const call = callOfStep(node);
    const opens = call !== undefined && opensFrame(call) ? { node: call.id, fn: call.target.id } : undefined;
    const toggles = stepToggles(node);
    const made = box(node, entries, inside, { title: toggles ? `▸ ${label}` : label, titleCode: false, code: call?.code ?? codeLines(shown(body)), step: { id: node.id, open: false, toggles } });
    if (opens !== undefined) made.opens = opens;
    made.rows.push(...exitRows(inside.filter(isExit)));
    return ends(body, enabled) ? [] : [{ from: made.id, kind: 'flow' }];
  };
  /**
   * A `try`: the boxes of its body inside its region, and what an exception
   * does: a row of the region when the catch ends at once or does nothing,
   * else the boxes of the catch after the region, entered by a red arrow from
   * it. A `finally` follows. A body with nothing in it has no region: the try
   * is a box of its own, with the same row or arrow.
   */
  const attempt = (node: TreeNode, entries: Pending[]): Pending[] => {
    const branches = branchesOf(node, enabled);
    const body = shown(branches.find((branch) => branch.key === 'try')?.nodes ?? []);
    const handler = branches.find((branch) => branch.key === 'catch');
    const final = branches.find((branch) => branch.key === 'finally');
    const caught = handler === undefined ? undefined : shown(handler.nodes);
    const row: DiagramRow | undefined =
      caught === undefined ? undefined
      : caught.length === 0 ? { full: '例外 → 無視して先へ進む', tone: 'pass', side: { node: node.id, side: 'catch' }, ends: [] }
      : endsAtOnce(caught) ? sideRow(node, 'catch', caught, '例外')
      : undefined;
    const held = row === undefined || caught === undefined ? [] : ids(caught);
    let out: Pending[];
    let from: string;
    let region: DiagramGroup | undefined;
    if (body.length === 0) {
      const made = box(node, entries);
      if (row !== undefined) made.rows.push(row);
      made.holds.push(...held);
      out = [{ from: made.id, kind: 'flow' }];
      from = made.id;
    } else {
      const parent = regions[regions.length - 1];
      region = {
        id: `g:${node.id}`,
        node: node.id,
        ...(parent === undefined ? {} : { parent: parent.id }),
        members: [],
        title: '例外を捕まえる範囲',
        rows: row === undefined ? [] : [row],
        outcome: row?.full ?? (caught === undefined ? '例外は捕まえずに、finally のあと呼び出し元へ投げ直す' : ''),
        code: node.code,
        holds: [node.id, ...held],
        calls: [],
      };
      groups.push(region);
      const first = nodes.length;
      regions.push(region);
      out = list(body, entries);
      regions.pop();
      region.members = nodes.slice(first).map((made) => made.id);
      from = region.id;
    }
    if (handler !== undefined && row === undefined) {
      const first = nodes.length;
      out = [...out, ...list(handler.nodes, [{ from, kind: 'error', label: '例外が起きたとき', side: { node: node.id, side: 'catch' } }])];
      const into = nodes[first];
      if (region !== undefined) region.outcome = `例外 → 赤い破線の矢印の先へ進む${into === undefined ? '' : `（${into.title.replace(/^[▸▾] /, '')}）`}`;
    }
    if (final !== undefined) out = list(final.nodes, out);
    return out;
  };
  const loop = (node: TreeNode, entries: Pending[], folded: readonly TreeNode[]): Pending[] => {
    const branches = branchesOf(node, enabled);
    const body = branches.find((branch) => branch.key === 'body');
    const inside = shown(body?.nodes ?? []);
    const only = inside[0];
    // A loop of one call or one action that decides nothing is one box, unless the pull request changed it: its line says what it repeats.
    if (inside.length === 1 && only !== undefined && (only.kind === 'call' || only.kind === 'action') && only.branches === undefined && !below(inside).some((child) => DECISION_KINDS.has(child.kind)) && !changed(node.id) && !holdsChange(inside)) {
      const made = box(node, entries, folded, { code: `${node.code}\n${only.code}` });
      made.title = `${made.title} → ${sideLine(inside)}`;
      made.holds.push(...ids(inside));
      offer(made, callsToOpen(inside));
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
      // The calls of the side folded in stay within reach (the outline's rule folds no side that calls a function with a frame).
      offer(made, callsToOpen(yes, exits ? made.rows.length : undefined));
      if (exits) made.rows.push(sideRow(node, 'true', yes, branches.find((branch) => branch.key === 'true')?.label ?? '成立'));
      else if (yes.length > 0) {
        // An optional item says what it does on its line, as the outline does.
        made.title = `${made.title} → ${sideLine(yes)}`;
        made.code = `${made.code}\n→ ${yes.map((child) => child.code).join('、')}`;
      }
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
        offer(made, callsToOpen(side, made.rows.length));
        made.rows.push(sideRow(node, branch.key, side, branch.label));
        made.holds.push(...ids(side));
        continue;
      }
      out.push(...list(branch.nodes, [{ from: made.id, kind: 'branch', label: branch.label, side: { node: node.id, side: branch.key } }]));
    }
    return out;
  };

  const signature = tree.signature || tree.name;
  nodes.push({ id: 'start', title: signature, titleCode: false, code: signature, tone: 'start', rows: [], holds: [], calls: [] });
  list(tree.nodes, [{ from: 'start', kind: 'flow' }]);
  const byId = new Map(everyNode(tree.nodes).map((node) => [node.id, node]));
  // What a held call reaches, as the outline's rows count it (heldBy in trace.ts): a function, or a member of an interface.
  const callee = (id: string): string[] => {
    const held = byId.get(id);
    return held?.kind === 'call' && (held.target?.kind === 'function' || held.target?.kind === 'member') ? [held.target.id] : [];
  };
  for (const made of [...nodes, ...groups]) made.calls = [...new Set(made.holds.flatMap(callee))];
  return { key: `frame:${tree.id}:${frame}`, nodes, edges, sides, groups };
}

/** Whether a shape of the diagram is a region rather than a box. */
export function isRegion(shape: DiagramNode | DiagramGroup): shape is DiagramGroup {
  return 'members' in shape;
}

/**
 * The boxes, regions, arrows and rows the choices run through: a box whose
 * node runs, a region whose `try` runs, an arrow between two of those on the
 * chosen side, and a row (`<box or region>|<index>`) one of whose exits runs;
 * a row that ends nothing (a catch that ignores the exception) is on when its
 * decision runs and the choices take its side or none.
 */
export function activeOf(diagram: Diagram, tree: FlowTree, frame: string, choices: readonly Decisions[], enabled?: ReadonlySet<string>): { nodes: Set<string>; edges: Set<number>; rows: Set<string>; groups: Set<string> } {
  const run = nodesRun(tree, frame, choices, enabled);
  const nodes = new Set<string>(['start']);
  for (const node of diagram.nodes) if (node.node !== undefined && run.has(node.node)) nodes.add(node.id);
  const groups = new Set(diagram.groups.filter((group) => run.has(group.node)).map((group) => group.id));
  /** The side the choices (or a feature that is off) take at a decision; undefined for none. */
  const taken = (side: { node: string; side: string }): string | undefined => {
    const treeNode = findNode(tree.nodes, side.node);
    return (treeNode === undefined ? undefined : forcedSide(treeNode, enabled)) ?? chosenSide(choices, decisionKey(frame, side.node));
  };
  const live = (id: string) => nodes.has(id) || groups.has(id);
  const edges = new Set<number>();
  diagram.edges.forEach((edge, index) => {
    if (!live(edge.from) || !live(edge.to)) return;
    const side = diagram.sides.get(index);
    const chosen = side === undefined ? undefined : taken(side);
    if (side !== undefined && chosen !== undefined && chosen !== side.side) return;
    edges.add(index);
  });
  const rows = new Set<string>();
  for (const shape of [...diagram.nodes, ...diagram.groups]) {
    shape.rows.forEach((row, index) => {
      const side = row.side;
      const on = row.ends.length > 0 ? row.ends.some((id) => run.has(id)) : side !== undefined && run.has(side.node) && [undefined, side.side].includes(taken(side));
      if (on) rows.add(`${shape.id}|${index}`);
    });
  }
  return { nodes, edges, rows, groups };
}

/** The box or the region that shows a node of the tree: the box that holds it, else the region of a `try` (the try itself, a catch that is a row), else what shows its nearest ancestor; undefined when nothing does. */
export function boxOf(diagram: Diagram, node: string): DiagramNode | DiagramGroup | undefined {
  const shape = diagram.nodes.find((candidate) => candidate.holds.includes(node)) ?? diagram.groups.find((candidate) => candidate.holds.includes(node));
  if (shape !== undefined) return shape;
  // An id is the id of the node it is under and its place there (`s0b1s0` under `s0b1`, `s5i0` under `s5`).
  const parent = node.replace(/[a-z]+[0-9]+$/, '');
  return parent === node || parent === '' ? undefined : boxOf(diagram, parent);
}

/** The height of every box: one line (34px). */
export function boxHeight(): number {
  return 34;
}

/** The room the label of a region takes at its top, from its border to its first box: one line and the space below it. */
export const REGION_HEADER = 28;

/** How wide the text of a line draws (see FontWidths): a title (12.5px, semibold), a title that is code (12px, the code font), a tag (12px, semibold), the label of a region and its tags (11px, as the labels of the arrows). */
const TITLE_FONT: FontWidths = { wide: 12.5, narrow: 7 };
const CODE_FONT: FontWidths = { wide: 12, narrow: 7.25 };
const TAG_FONT: FontWidths = { wide: 12, narrow: 6.8 };
const LABEL_FONT: FontWidths = { wide: 11, narrow: 6.1 };
/** The room between the edges of a box and its line. */
export const BOX_INSET = 12;
/** The room between the edges of a region and its label. */
export const REGION_INSET = 10;
/** The room between the parts of the line of a box. */
const GAP = 8;

/** A tag at the end of a line: how a box ends the flow there (`→ 終わり`, `→ 失敗 ×2`), or what a region does with an exception (`→ 例外: 失敗`). */
export interface ExitTag {
  tone: DiagramRow['tone'];
  text: string;
  /** The rows it stands for, by index: it is on the chosen way when one of them is; none for a box's own exit (a return, a throw), which is on with its box. */
  rows: number[];
  /** The pixels it takes in its font. */
  width: number;
}

/** A line as a box or the label of a region draws it: its title, cut with an ellipsis to the room its tags and its badge leave, and its tags. */
export interface ShapeLine {
  title: string;
  /** Whether the title was cut. */
  cut: boolean;
  /** The pixels the title may take. */
  room: number;
  tags: ExitTag[];
}

/** A tag of a text and its rows, measured in a font. */
function tag(tone: DiagramRow['tone'], text: string, rows: number[], font: FontWidths = TAG_FONT): ExitTag {
  return { tone, text, rows, width: Math.ceil(textPixels(text, font)) };
}

/**
 * The tags at the end of the line of a box: its own exit (`→ 終わり` for a
 * return, `→ 失敗` for a throw), then its rows by how they end, the returns
 * before the throws, `×n` when they end several ways (an exit a row stands
 * for counts once).
 */
export function exitTags(box: DiagramNode): ExitTag[] {
  const own = box.node === undefined ? [] : box.tone === 'end' ? [tag('end', '→ 終わり', [])] : box.tone === 'error' ? [tag('error', '→ 失敗', [])] : [];
  const byTone = (['end', 'error', 'pass'] as const).flatMap((tone) => {
    const rows = box.rows.flatMap((row, index) => (row.tone === tone ? [index] : []));
    if (rows.length === 0) return [];
    const count = rows.reduce((sum, index) => sum + Math.max(1, (box.rows[index] as DiagramRow).ends.length), 0);
    const words = tone === 'error' ? '→ 失敗' : tone === 'end' ? '→ 終わり' : '→ 先へ進む';
    return [tag(tone, count === 1 ? words : `${words} ×${count}`, rows)];
  });
  return [...own, ...byTone];
}

/** The tags of the label of a region: what each of its rows does with an exception (`→ 例外: 失敗`, `→ 例外: 終わり`, `→ 例外は無視して先へ`). */
export function regionTags(group: DiagramGroup): ExitTag[] {
  return group.rows.map((row, index) => tag(row.tone, row.tone === 'pass' ? '→ 例外は無視して先へ' : row.tone === 'error' ? '→ 例外: 失敗' : '→ 例外: 終わり', [index], LABEL_FONT));
}

/** The line of a box at a width, with a badge `badgeWidth` wide (its gap included) at its right: the title gets the room the tags and the badge leave. */
export function boxLine(box: DiagramNode, width: number, badgeWidth = 0): ShapeLine {
  const tags = box.tone === 'start' ? [] : exitTags(box);
  const room = width - 2 * BOX_INSET - badgeWidth - tags.reduce((sum, item) => sum + item.width + GAP, 0);
  const title = truncatePixels(box.title, room, box.titleCode ? CODE_FONT : TITLE_FONT);
  return { title, cut: title !== box.title, room, tags };
}

/** The line of the label of a region as wide as `width`, with a badge `badgeWidth` wide (its gap included) at its right: its tags stand at the end, 6px apart. */
export function regionLine(group: DiagramGroup, width: number, badgeWidth = 0): ShapeLine {
  const tags = regionTags(group);
  const room = width - 2 * REGION_INSET - badgeWidth - tags.reduce((sum, item) => sum + item.width + 6, 0);
  const title = truncatePixels(group.title, room, LABEL_FONT);
  return { title, cut: title !== group.title, room, tags };
}

/** Lay out a diagram as FlowDiagram draws it (see layoutGraph): every box one line high, every region with the room of its label. */
export function layoutDiagram(diagram: Diagram, shown: ReadonlySet<number>, direction: LayoutDirection = 'TB') {
  return layoutGraph(diagram.nodes, diagram.edges, shown, direction, { height: () => boxHeight(), groups: diagram.groups, header: () => REGION_HEADER });
}

/** The action that looks inside a call, with the row it goes with. */
function openAction(call: { node: string; fn: string; row?: number }): CardAction {
  return { kind: 'open', node: call.node, fn: call.fn, name: `${call.fn.slice(call.fn.indexOf('#') + 1)}()`, ...(call.row === undefined ? {} : { row: call.row }) };
}

/** What the card of a box or a region offers (see CardAction): to look inside the call a box opens and each other call it holds within reach (one of a row with that row), to open or fold its step, and to open the step each of its rows names. */
export function boxActions(shape: DiagramNode | DiagramGroup): CardAction[] {
  const actions: CardAction[] = [];
  if (!isRegion(shape) && shape.opens !== undefined) actions.push(openAction(shape.opens));
  if (!isRegion(shape)) actions.push(...(shape.alsoOpens ?? []).map(openAction));
  if (!isRegion(shape) && shape.step !== undefined && (shape.step.open || shape.step.toggles)) actions.push({ kind: 'toggle', step: shape.step.id, open: shape.step.open });
  shape.rows.forEach((row, index) => {
    if (row.step !== undefined) actions.push({ kind: 'toggle', step: row.step, open: false, row: index });
  });
  return actions;
}

/** The lines that describe a box or a row read as one label (its aria-label): a sentence a line, joined with '。', the full stop a line ends with (`。`, `.`) taking the place of the one between. */
export function spokenLabel(lines: readonly string[]): string {
  return lines.map((line) => line.replace(/[。．.]$/, '')).join('。');
}

/**
 * The badge of a box or a region, by the rule a row of the outline follows
 * (heldMarks in changes.ts): the strongest of the badges of the nodes it
 * holds (the change of the frame) and of what its calls reach, the functions
 * and the members of interfaces whose implementations lead to a change.
 */
export function markOfBox(box: Pick<DiagramNode, 'holds' | 'calls'>, change: FrameChange | undefined, changes: ChangeIndex | undefined): Mark | undefined {
  return heldMarks(changes, change, box.holds, box.calls).mark;
}
