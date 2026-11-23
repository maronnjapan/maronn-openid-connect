/**
 * The reading of a measured request: what ran while one request was
 * answered (the Istanbul counters of the statements, branches and functions
 * that went up, at their places in the original sources) read against the
 * trees of the map, to tell the side each decision took and whether a node
 * ran. The test catalog reads the requests the measured API tests sent with
 * it (packages/test-catalog examples.ts); the page of the map can read a
 * request it runs the same way, so one set of rules tells the way a request
 * took wherever it was sent.
 *
 * A decision is read in the file of the frame it is in, by the lines of its
 * node and the source text there (a node has lines, no columns):
 *
 * - `if`: the Istanbul `if` branch that starts on its lines where the text
 *   reads `if` (the first one: an `if` inside it starts later); its
 *   consequent ran → true, its alternate → false;
 * - `switch`: the `switch` branch at its keyword: the clause whose counter
 *   went up (and those it falls through to) → the side at that place;
 * - `??`, `||`, `&&`: the `binary-expr` branch of two operands that starts
 *   at the left operand: whether the right one ran (`??` nullish, `||`
 *   false, `&&` true) or not; `?:`: the `cond-expr` branch at its test, as
 *   an `if`;
 * - `try`: catch when a statement of its catch ran, else try when a
 *   statement of its body ran;
 * - a loop: body when a statement of its body ran on a line of its own,
 *   skip when the head of a `for` or `while` ran and its body did not;
 * - a call: it fails when it ran (a statement on its lines and, for a
 *   function of the catalog, that function) and the node that runs next when
 *   it returns did not (the next of its list, or of the block, `if` or
 *   cond-expr it ends); it goes on when that node ran.
 *
 * A decision its frame took both ways while one request was answered (the
 * frame ran twice) is seen both ways, which contradicts no side; a node
 * whose lines are not its own (the body of a local function the tree puts
 * on the lines of its call) is not read. These are rules, not guesses: what
 * they cannot tell is left unseen.
 *
 * This module imports only types and the walk, so the page of the map uses
 * it as it is: `@maronn-openid-connect/map-analysis/observe`.
 */
import type { Decisions, FlowTree, MapData, TreeNode } from './model.js';
import { FAILS, nodesOf } from './walk.js';

/** The side seen for a decision its frame took both ways while one request was answered: it contradicts no side. */
export const BOTH = 'both';

/** The side seen for a call the request went on past: it contradicts FAILS. */
export const GOES = 'goes';

/**
 * What ran in one file of the repository while a request was answered: the
 * statements `[line, column, increment]`, the branches `[line, column, type,
 * increments]` (one increment a location of the branch, in Istanbul's order)
 * and the functions `[line, name?]` whose counter went up, at their places in
 * the original source (lines from 1, columns from 0). The shape test-reach
 * records (RanInFile).
 */
export interface RanInFile {
  s: Array<[number, number, number]>;
  b: Array<[number, number, string, number[]]>;
  f: Array<[number, string] | [number]>;
}

/** A request with what ran while it was answered, by repository path of the original source. */
export interface RanRequest {
  ran: Record<string, RanInFile>;
}

/** What the rules read besides a request: the trees, the files and the frames of the map. */
export interface RunSources {
  /** The tree of a frame, by id. */
  treeOf(id: string): FlowTree | undefined;
  /** The repository path of the file of a tree (FlowTree.file, a key of MapData.sources). */
  pathOf(file: string): string | undefined;
  /** The lines of a file of the repository, by its path. */
  linesOf(path: string): readonly string[] | undefined;
  /** The frame a line of a file is in (FrameLocator). */
  frameAt(path: string, line: number): string | undefined;
}

/** Where the functions and the bodies of the map are, to name the function a position of a source is in. */
export class FrameLocator {
  private readonly byPath = new Map<string, Array<{ id: string; start: number; end: number }>>();

  constructor(data: Pick<MapData, 'functions' | 'bodies' | 'sources'>) {
    for (const entry of [...Object.values(data.functions), ...Object.values(data.bodies)]) {
      if (entry.source === undefined) continue;
      const path = data.sources[entry.source.file]?.path;
      if (path === undefined) continue;
      this.byPath.set(path, [...(this.byPath.get(path) ?? []), { id: entry.id, start: entry.source.start, end: entry.source.end }]);
    }
  }

  /** The frame a line of a source is in: the innermost one (a bundler may rename a function, so the place decides, not the name). */
  frameAt(path: string, line: number): string | undefined {
    let best: { id: string; start: number; end: number } | undefined;
    for (const frame of this.byPath.get(path) ?? []) {
      if (line < frame.start || line > frame.end) continue;
      if (best === undefined || frame.end - frame.start < best.end - best.start) best = frame;
    }
    return best?.id;
  }
}

/** A node of a tree and where it is: the list it is in, the node that holds that list. */
export interface Place {
  node: TreeNode;
  list: readonly TreeNode[];
  index: number;
  /** The node whose side or pre the list is; undefined for the body of the frame. */
  owner?: TreeNode;
  /** The list is the pre of `owner`. */
  pre: boolean;
  /** The node is in the body of a local function the tree inlines on the lines of its call: its lines are not its own. */
  inlined: boolean;
}

/** A node found by its decision key (`<frame>.<node>`): the tree of its frame, and its place there. */
export interface Located {
  tree: FlowTree;
  place: Place;
}

const PLACES = new WeakMap<FlowTree, Map<string, Place>>();

/** Whether a loop is the body of a local function the tree inlines (one side, not a `do`), whose nodes take the lines of the call. */
function isInlined(node: TreeNode): boolean {
  return node.kind === 'loop' && !(node.branches ?? []).some((branch) => branch.key === 'skip') && !node.code.startsWith('do');
}

/** The place of every node of a tree, by id (kept by tree). */
export function placesOf(tree: FlowTree): Map<string, Place> {
  const known = PLACES.get(tree);
  if (known !== undefined) return known;
  const places = new Map<string, Place>();
  const visit = (list: readonly TreeNode[], owner: TreeNode | undefined, pre: boolean, inlined: boolean): void => {
    list.forEach((node, index) => {
      places.set(node.id, { node, list, index, ...(owner === undefined ? {} : { owner }), pre, inlined });
      if (node.pre !== undefined) visit(node.pre, node, true, inlined);
      for (const branch of node.branches ?? []) visit(branch.nodes, node, false, inlined || isInlined(node));
    });
  };
  visit(tree.nodes, undefined, false, false);
  PLACES.set(tree, places);
  return places;
}

/** The node a decision key names: its frame found by following the call nodes of the key from the root to the trees they call. */
export function locate(key: string, root: FlowTree, treeOf: (id: string) => FlowTree | undefined): Located | undefined {
  const parts = key.split('.');
  let tree = root;
  for (const [index, id] of parts.entries()) {
    const place = placesOf(tree).get(id);
    if (place === undefined) return undefined;
    if (index === parts.length - 1) return { tree, place };
    const target = place.node.target;
    if (place.node.kind !== 'call' || target?.kind !== 'function') return undefined;
    const next = treeOf(target.id);
    if (next === undefined) return undefined;
    tree = next;
  }
  return undefined;
}

/** A file as a request is read in it: its lines and what ran in it. */
interface FileRun {
  lines: readonly string[];
  ran: RanInFile;
}

const NOTHING: RanInFile = { s: [], b: [], f: [] };

/** What ran while one request was answered, read against the files of the trees. */
export class RequestRun {
  /** The frames whose function counter went up, by id. */
  readonly frames: ReadonlySet<string>;
  private readonly files = new Map<string, FileRun | undefined>();

  constructor(
    readonly exchange: RanRequest,
    private readonly sources: RunSources,
  ) {
    const frames = new Set<string>();
    for (const [path, ran] of Object.entries(exchange.ran)) {
      for (const [line] of ran.f) {
        const frame = sources.frameAt(path, line);
        if (frame !== undefined) frames.add(frame);
      }
    }
    this.frames = frames;
  }

  /** The file of a tree with what ran in it (nothing when the request ran none of it); undefined when its text is not there. */
  fileOf(tree: FlowTree): FileRun | undefined {
    const path = this.sources.pathOf(tree.file);
    if (path === undefined) return undefined;
    if (!this.files.has(path)) {
      const lines = this.sources.linesOf(path);
      this.files.set(path, lines === undefined ? undefined : { lines, ran: this.exchange.ran[path] ?? NOTHING });
    }
    return this.files.get(path);
  }

  /**
   * Whether a call of a tree ran in this request: the function it calls ran
   * and a statement on the call's lines ran. The function counter alone is
   * not enough: it goes up wherever the function is called, so a step that
   * did not call it (a dispatch that let the grant pass) would seem to.
   */
  callRan(tree: FlowTree, node: TreeNode): boolean {
    if (node.target?.kind !== 'function' || !this.frames.has(node.target.id)) return false;
    const file = this.fileOf(tree);
    return file !== undefined && statements(file, node.lines[0], node.lines[1]).length > 0;
  }

  /** The functions a frame called in this request, in the order of its tree: the targets of its calls that ran (callRan); none when its tree is not there. */
  calledBy(frame: string): string[] {
    const tree = this.sources.treeOf(frame);
    if (tree === undefined) return [];
    return [...nodesOf(tree.nodes)].flatMap((node) => (node.kind === 'call' && node.target?.kind === 'function' && this.callRan(tree, node) ? [node.target.id] : []));
  }
}

/** The order of two places of a file. */
function byPlace(a: readonly [number, number, ...unknown[]], b: readonly [number, number, ...unknown[]]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** The statements that ran on lines from `from` to `to` (inclusive), in the order of their places. */
function statements(file: FileRun, from: number, to: number): Array<[number, number, number]> {
  return file.ran.s.filter(([line, , count]) => line >= from && line <= to && count > 0).sort(byPlace);
}

/** The statements that ran on the lines of some nodes, in the order of their places. */
function statementsIn(file: FileRun, nodes: readonly TreeNode[]): Array<[number, number, number]> {
  return file.ran.s.filter(([line, , count]) => count > 0 && nodes.some((node) => line >= node.lines[0] && line <= node.lines[1])).sort(byPlace);
}

/** Whether the text reads a keyword at a place (`if`, not `iframe`). */
function readsWord(file: FileRun, line: number, column: number, word: string): boolean {
  const text = file.lines[line - 1]?.slice(column) ?? '';
  return text.startsWith(word) && !/[\w$]/.test(text[word.length] ?? '');
}

/**
 * Code as the rules compare it: no whitespace but one space between two
 * words (`typeof x`, `await f`), and none of the parentheses that open it
 * (the build may drop those it does not need, `(await f()) ?? g` → `await
 * f() ?? g`, and the counters then start past them).
 */
function tight(code: string): string {
  return code
    .replace(/\s+/g, ' ')
    .replace(/(?<![\w$]) | (?![\w$])/g, '')
    .replace(/^\(+/, '');
}

/**
 * The start of an expression as code to find it by in the text: its leading
 * name and what it reads of it (`refreshTokenRequest`, `await loadClient`,
 * `typeof storage`, `!c.get`); undefined when the code does not start with
 * a name.
 */
function headOf(code: string): string | undefined {
  const match = /^[!(\s]*(?:(?:await|new|typeof)\s+)*[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/.exec(code);
  const head = match === null ? '' : tight(match[0]);
  return head === '' ? undefined : head;
}

/** Whether the code from a place reads `head` (see tight), and a name does not go on past it. */
function readsCode(file: FileRun, line: number, column: number, head: string): boolean {
  let text = file.lines[line - 1]?.slice(column) ?? '';
  for (let next = line; next < line + 8 && tight(text).length <= head.length; next += 1) text += `\n${file.lines[next] ?? ''}`;
  const flat = tight(text);
  return flat.startsWith(head) && !/[\w$]/.test(flat[head.length] ?? '');
}

/** The first branch of a type that ran on the lines of a node at a place that `at` accepts. */
function branchAt(file: FileRun, node: TreeNode, type: string, at: (line: number, column: number) => boolean): [number, number, string, number[]] | undefined {
  return file.ran.b.filter(([line, column, kind]) => kind === type && line >= node.lines[0] && line <= node.lines[1] && at(line, column)).sort(byPlace)[0];
}

/** The side of a decision of two ways from the increments of its two locations: the first, the second, both, or neither. */
function twoSides(increments: readonly number[], first: string, second: string): string | undefined {
  const [a = 0, b = 0] = increments;
  if (a > 0 && b > 0) return BOTH;
  if (a > 0) return first;
  return b > 0 ? second : undefined;
}

/** The side an `if` took. */
function ifSide(file: FileRun, node: TreeNode): string | undefined {
  const branch = branchAt(file, node, 'if', (line, column) => readsWord(file, line, column, 'if'));
  return branch === undefined ? undefined : twoSides(branch[3], 'true', 'false');
}

/**
 * The handler an endpoint of several handlers ran (the choice the map makes
 * of them, which no `switch` of the code is): the one side with a statement
 * that ran on its lines, each handler on lines of its own.
 */
function handlerSide(file: FileRun, node: TreeNode): string | undefined {
  const ran = (node.branches ?? []).filter((branch) => statementsIn(file, branch.nodes).length > 0);
  if (ran.length > 1) return BOTH;
  return ran[0]?.key;
}

/** The side a `switch` took: the clause it entered, the ones that clause falls through to having run too. */
function switchSide(file: FileRun, node: TreeNode): string | undefined {
  if (!/^switch\s*\(/.test(node.code)) return handlerSide(file, node);
  const branch = branchAt(file, node, 'switch', (line, column) => readsWord(file, line, column, 'switch'));
  if (branch === undefined) return undefined;
  const counts = branch[3];
  const sides = node.branches ?? [];
  // The tree adds a `default` side of no clause when the code has none; Istanbul counts the clauses only.
  const clauses = sides.length === counts.length + 1 && sides[sides.length - 1]?.key === 'default' ? sides.slice(0, -1) : sides;
  if (clauses.length !== counts.length) return undefined;
  const entered = counts.flatMap((count, index) => (count > 0 ? [index] : []));
  const first = entered[0];
  if (first === undefined) return undefined;
  let last = first;
  while (clauses[last]?.fallsThrough === true && last + 1 < clauses.length) last += 1;
  const once = entered.every((index, at) => index === first + at && index <= last && counts[index] === counts[first]);
  return once ? (clauses[first] as { key: string }).key : BOTH;
}

/** The sides of a logical operator: the one where its right operand does not run, and the one where it does. */
const LOGICAL: Readonly<Record<string, [skipped: string, evaluated: string]>> = {
  '??': ['defined', 'nullish'],
  '||': ['true', 'false'],
  '&&': ['false', 'true'],
};

/** The side a cond-expr took (`??`, `||`, `&&` by whether its right operand ran, `?:` by its arm). */
function condSide(file: FileRun, node: TreeNode): string | undefined {
  const head = headOf(node.subject ?? '');
  if (head === undefined) return undefined;
  const at = (line: number, column: number) => readsCode(file, line, column, head);
  if (node.operator === '?:') {
    const branch = branchAt(file, node, 'cond-expr', at);
    return branch === undefined ? undefined : twoSides(branch[3], 'true', 'false');
  }
  const sides = LOGICAL[node.operator ?? ''];
  if (sides === undefined) return undefined;
  const branch = branchAt(file, node, 'binary-expr', at);
  // A chain of more operands counts each leaf: which of them the right operand starts at is not in the counts.
  if (branch === undefined || branch[3].length !== 2) return undefined;
  const [times = 0, right = 0] = branch[3];
  if (times === 0) return undefined;
  if (right === 0) return sides[0];
  return right === times ? sides[1] : BOTH;
}

/** The side a `try` took: catch when its catch ran (both when its body ran more often), else try when its body ran. */
function trySide(file: FileRun, node: TreeNode): string | undefined {
  const handler = node.branches?.find((branch) => branch.key === 'catch');
  if (handler === undefined || handler.nodes.length === 0) return undefined;
  const caught = statementsIn(file, handler.nodes);
  const first = caught[0];
  if (first !== undefined) {
    const tried = statements(file, node.lines[0], node.lines[1]).find(([line, column]) => readsWord(file, line, column, 'try'));
    return tried !== undefined && tried[2] > first[2] ? BOTH : 'catch';
  }
  const body = node.branches?.find((branch) => branch.key === 'try')?.nodes ?? [];
  return statementsIn(file, body).length > 0 ? 'try' : undefined;
}

/** The first line of a node that holds code: its comments above it left out. */
function headLine(file: FileRun, node: TreeNode): number | undefined {
  for (let line = node.lines[0]; line <= node.lines[1]; line += 1) {
    const text = (file.lines[line - 1] ?? '').trim();
    if (text !== '' && !text.startsWith('//') && !text.startsWith('/*') && !text.startsWith('*')) return line;
  }
  return undefined;
}

/** The side a loop took: body when its body ran on a line of its own, skip when the head of a `for` or `while` ran and its body did not. */
function loopSide(file: FileRun, node: TreeNode): string | undefined {
  const body = node.branches?.find((branch) => branch.key === 'body');
  const skip = node.branches?.find((branch) => branch.key === 'skip');
  if (body === undefined || isInlined(node)) return undefined;
  const head = headLine(file, node);
  if (head === undefined) return undefined;
  if (statementsIn(file, body.nodes).some(([line]) => line !== head)) return 'body';
  const ownLines = body.nodes.length > 0 && body.nodes.every((child) => child.lines[0] > head);
  const headRan = statements(file, head, head).some(([line, column]) => readsWord(file, line, column, 'for') || readsWord(file, line, column, 'while'));
  return skip !== undefined && /^(?:for|while)\b/.test(node.code) && ownLines && headRan ? 'skip' : undefined;
}

/** Whether a node runs a statement Istanbul counts whenever it runs (a declaration of a function, a type or a bare variable runs none). */
function observable(node: TreeNode): boolean {
  if (node.kind === 'end') return false;
  if (node.kind === 'block') return (node.branches?.[0]?.nodes ?? []).some(observable);
  if (node.kind !== 'action') return true;
  const code = node.code.replace(/\s+/g, ' ').trim();
  return !/^(?:export )?(?:default )?(?:async )?(?:function|class|type|interface|declare|abstract|enum|const enum)\b/.test(code) && !/^(?:let|var|const) [^=]*$/.test(code);
}

/**
 * The node that runs next when a node returns: the next of its list that
 * Istanbul counts, or when it ends its list, the next after the block, the
 * `if` or the cond-expr whose side the list is. Undefined where that is not
 * one node: after a loop's body, a `try`'s, a `switch`'s clause, or the
 * pre of a node (the node itself runs on after it, and may fail).
 */
function nextOf(tree: FlowTree, place: Place): TreeNode | undefined {
  let at: Place | undefined = place;
  while (at !== undefined) {
    const next = at.list.slice(at.index + 1).find(observable);
    if (next !== undefined) return next;
    const owner: TreeNode | undefined = at.owner;
    if (owner === undefined || at.pre || !['block', 'if', 'cond-expr'].includes(owner.kind)) return undefined;
    at = placesOf(tree).get(owner.id);
  }
  return undefined;
}

/** Whether a call ran: a statement on its lines, and for a function of the catalog, that function. */
function called(file: FileRun, node: TreeNode, run: RequestRun): boolean {
  if (statements(file, node.lines[0], node.lines[1]).length === 0) return false;
  return node.target?.kind !== 'function' || run.frames.has(node.target.id);
}

/** Whether a call failed (FAILS) or the request went on past it (GOES), when the node that runs next tells. */
function callSide(file: FileRun, located: Located, run: RequestRun): string | undefined {
  const node = located.place.node;
  const next = nextOf(located.tree, located.place);
  // The next node has to have lines of its own to tell whether it ran.
  if (next === undefined || next.lines[1] <= node.lines[1]) return undefined;
  if (statements(file, Math.max(next.lines[0], node.lines[1] + 1), next.lines[1]).length > 0) return GOES;
  return called(file, node, run) ? FAILS : undefined;
}

/** The side a decision (or a call) took while the request was answered (see the module comment), BOTH, GOES, or undefined when the rules cannot tell. */
export function seenSide(located: Located, run: RequestRun): string | undefined {
  if (located.place.inlined || located.tree.synthetic === true) return undefined;
  const file = run.fileOf(located.tree);
  if (file === undefined) return undefined;
  const node = located.place.node;
  switch (node.kind) {
    case 'if':
      return ifSide(file, node);
    case 'switch':
      return switchSide(file, node);
    case 'cond-expr':
      return condSide(file, node);
    case 'try':
      return trySide(file, node);
    case 'loop':
      return loopSide(file, node);
    case 'call':
      return callSide(file, located, run);
    default:
      return undefined;
  }
}

/**
 * Whether a node ran: a statement on its lines (for a throw, one that reads
 * `throw`; for a return, one that reads `return` or, for the body of an
 * arrow function the map reads as a return, what it returns); never for the
 * end of a body, which has none.
 */
export function nodeRan(located: Located, run: RequestRun): boolean {
  if (located.place.inlined || located.tree.synthetic === true) return false;
  const file = run.fileOf(located.tree);
  if (file === undefined) return false;
  const node = located.place.node;
  const found = statements(file, node.lines[0], node.lines[1]);
  switch (node.kind) {
    case 'return': {
      const value = headOf(node.code.replace(/^return\b\s*/, ''));
      return found.some(([line, column]) => readsWord(file, line, column, 'return') || (value !== undefined && readsCode(file, line, column, value)));
    }
    case 'throw':
      return found.some(([line, column]) => readsWord(file, line, column, 'throw'));
    case 'block':
      return found.length > 0;
    default:
      return found.length > 0 && observable(node);
  }
}


/** The kinds of node a request is read at: the decisions and the calls (which may fail). */
const READ: ReadonlySet<string> = new Set(['if', 'switch', 'loop', 'try', 'cond-expr', 'call']);

/** The key a choice gives a node of a frame: the node alone in the frame a walk starts in. */
function keyIn(frame: string, node: string): string {
  return frame === '' ? node : `${frame}.${node}`;
}

/**
 * The sides seen at the decisions of one frame while a request was answered:
 * every decision and call of its tree whose side the rules tell (seenSide),
 * keyed as a choice keys them (`<frame>.<node>`). A decision seen both ways
 * and a call seen going on are left out: the walk takes no side for them.
 */
export function seenDecisions(tree: FlowTree, run: RequestRun, frame = ''): Decisions {
  const decisions: Decisions = {};
  const places = placesOf(tree);
  for (const node of nodesOf(tree.nodes)) {
    const place = places.get(node.id);
    if (!READ.has(node.kind) || place === undefined) continue;
    const side = seenSide({ tree, place }, run);
    if (side === undefined || side === BOTH || side === GOES) continue;
    decisions[keyIn(frame, node.id)] = side;
  }
  return decisions;
}

/**
 * A choice that walks through the `try` of a frame whose body has a call
 * that fails: the side `catch` of such a `try` is left out, so the walk runs
 * its body up to that call and the failure takes it to the catch (the side
 * `catch` alone would skip the body).
 */
export function throughTries(tree: FlowTree, decisions: Decisions, frame = ''): Decisions {
  const through = { ...decisions };
  for (const node of nodesOf(tree.nodes)) {
    if (node.kind !== 'try' || decisions[keyIn(frame, node.id)] !== 'catch') continue;
    const body = node.branches?.find((branch) => branch.key === 'try')?.nodes ?? [];
    if ([...nodesOf(body)].some((inner) => inner.kind === 'call' && decisions[keyIn(frame, inner.id)] === FAILS)) delete through[keyIn(frame, node.id)];
  }
  return through;
}
