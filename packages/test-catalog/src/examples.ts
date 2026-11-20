/**
 * The requests measured API tests sent, joined to the cases of their
 * endpoint (cases.ts): what ran while a request was answered (the Istanbul
 * counters packages/test-reach records with it, RawExchange.ran) tells the
 * side each decision of the trees of the map took, so the cases the request
 * took; a case keeps the best of those requests as its examples, each with
 * the steps it ran and the response.
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
 * on the lines of its call) is not read. A request takes a case when no
 * decision of the case's choice is contradicted, at least one is seen (none
 * for a choice of no decision), the decisions the case hangs on are seen
 * (every side off the way a walk assumes, so never `responseMode ??= …`,
 * which Istanbul does not count; for the way into a step, the sides past
 * the way to its block; for a failure from below, the call of the
 * endpoint's frame it fails at), and the end of the case ran: the node its
 * way leads to, or for a failure the throw of its error in the function
 * that throws it, with an error status (or, for a case answered by a catch,
 * that catch) and no other OAuth error code in the response; a failure from
 * below is not taken when a `try` of a frame on its way up was seen catching
 * and no rethrow of that catch ran (it threw another error, or none). These are
 * rules, not guesses: what they cannot tell is left unseen, and a case no
 * request took has no example.
 */
import { Buffer } from 'node:buffer';
import { assumedSide, FAILS, nodesOf, stepsOf, walkFlow, wayTo, type Decisions, type FlowTree, type FlowWalk, type Selection, type TreeNode } from '@maronn-openid-connect/map-analysis';
import type { CaseCondition, CaseExample, EndpointCase, ExampleStep, ExchangeRun, RawExchange, TestCase } from './model.js';

/** The side seen for a decision its frame took both ways while one request was answered: it contradicts no side. */
export const BOTH = 'both';

/** The side seen for a call the request went on past: it contradicts FAILS. */
export const GOES = 'goes';

/** How many examples a case keeps. */
export const EXAMPLES = 3;

/** What the rules read besides a request: the trees, the files and the frames of the map. */
export interface CaseSources {
  /** The tree of a frame, by id. */
  treeOf(id: string): FlowTree | undefined;
  /** The repository path of the file of a tree (FlowTree.file, a key of MapData.sources). */
  pathOf(file: string): string | undefined;
  /** The lines of a file of the repository, by its path. */
  linesOf(path: string): readonly string[] | undefined;
  /** The frame a line of a file is in (run.ts FrameLocator). */
  frameAt(path: string, line: number): string | undefined;
}

/** A node of a tree and where it is: the list it is in, the node that holds that list. */
interface Place {
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
function placesOf(tree: FlowTree): Map<string, Place> {
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
  ran: ExchangeRun;
}

const NOTHING: ExchangeRun = { s: [], b: [], f: [] };

/** What ran while one request was answered, read against the files of the trees. */
export class RequestRun {
  /** The frames whose function counter went up, by id. */
  readonly frames: ReadonlySet<string>;
  private readonly files = new Map<string, FileRun | undefined>();

  constructor(
    readonly exchange: RawExchange,
    private readonly sources: CaseSources,
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

/** A case with the choice it is made from and its walk (cases.ts). */
export interface CaseWay {
  made: EndpointCase;
  selection: Selection;
  walked: FlowWalk;
}

/** A request a measured test sent, with the test. */
export interface SentRequest {
  test: TestCase;
  exchange: RawExchange;
}

/** The `try` nodes of a tree whose body holds a node, from the innermost out. */
function triesAround(tree: FlowTree, id: string): TreeNode[] {
  const places = placesOf(tree);
  const tries: TreeNode[] = [];
  let at = places.get(id);
  while (at?.owner !== undefined) {
    const { owner } = at;
    if (owner.kind === 'try' && !at.pre && owner.branches?.find((branch) => branch.key === 'try')?.nodes === at.list) tries.push(owner);
    at = places.get(owner.id);
  }
  return tries;
}

/**
 * Whether a failure from below got up through the frames between the
 * endpoint's and the one that throws it: no `try` of those frames whose body
 * holds the way on (the next call, or the throw) was seen catching without a
 * rethrow of its catch running. The map leaves those tries undecided (their
 * catch can throw what it caught), but one that caught the error and threw
 * another, or none, ended the failure there.
 */
function getsUp(way: CaseWay, tree: FlowTree, run: RequestRun, sources: CaseSources): boolean {
  const frames = way.selection.frames ?? [];
  const keys = [...frames, way.selection.target];
  return frames.every((frame, index) => {
    const call = locate(frame, tree, sources.treeOf)?.place.node;
    const callee = call?.target?.kind === 'function' ? sources.treeOf(call.target.id) : undefined;
    const next = keys[index + 1]?.slice(frame.length + 1).split('.')[0];
    if (callee === undefined || next === undefined) return true;
    return triesAround(callee, next).every((attempt) => {
      const located = locate(`${frame}.${attempt.id}`, tree, sources.treeOf);
      if (located === undefined || seenSide(located, run) !== 'catch') return true;
      const handler = attempt.branches?.find((branch) => branch.key === 'catch')?.nodes ?? [];
      return [...nodesOf(handler)].some((node) => {
        if (node.kind !== 'throw' || node.rethrow !== true) return false;
        const thrown = locate(`${frame}.${node.id}`, tree, sources.treeOf);
        return thrown !== undefined && nodeRan(thrown, run);
      });
    });
  });
}

/** Whether the catch the walk of a case runs at the endpoint's own frame ran. */
function caught(way: CaseWay, tree: FlowTree, run: RequestRun, sources: CaseSources): boolean {
  const stop = way.walked.stops.find((candidate) => candidate.depth === 0 && candidate.event === 'catches');
  const located = stop === undefined ? undefined : locate(stop.node.id, tree, sources.treeOf);
  return located !== undefined && seenSide(located, run) === 'catch';
}

/** Whether a side of a decision is the one a walk takes where a choice names none (a guard passed, no exception, a loop run): a way that takes another has to be seen taking it. */
function isAssumed(node: TreeNode, side: string): boolean {
  return assumedSide(node, (node.branches ?? []).filter((branch) => branch.always !== true))?.key === side;
}

/**
 * The OAuth error code a response names: the `error` of its JSON body, or
 * of the query or the fragment of the URL it redirects to; undefined when it
 * names none.
 */
export function responseError(response: NonNullable<RawExchange['response']>): string | undefined {
  try {
    const body = JSON.parse(response.body ?? '') as unknown;
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') return (body as { error: string }).error;
  } catch {
    // Not JSON: the error may be in the URL it redirects to.
  }
  const location = response.headers.find(([name]) => name === 'location')?.[1];
  if (location === undefined) return undefined;
  try {
    const url = new URL(location, 'https://op.invalid');
    return url.searchParams.get('error') ?? new URLSearchParams(url.hash.slice(1)).get('error') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a request took a case (see the module comment): no decision of
 * its choice contradicted, at least one seen, and seen where the evidence
 * hangs on it: every side the choice takes off the way a walk assumes (a
 * call that fails aside: the throw says it), for the way into a step every
 * side it takes past the way to its block (the use of the step's value
 * that tells the step apart), and for a failure from below the call of the
 * endpoint's frame it fails at; and the end of the case ran. For a failure
 * from below, no frame on its way up caught it without rethrowing it
 * (getsUp); for a failure with an OAuth code, the response names that code
 * when it names one.
 */
export function takes(way: CaseWay, tree: FlowTree, run: RequestRun, response: NonNullable<RawExchange['response']>, sources: CaseSources): boolean {
  const toBlock = way.made.kind === 'step' ? (wayTo(tree.nodes, way.selection.target)?.decisions ?? {}) : undefined;
  const failingCall = way.made.kind === 'failure' && way.selection.target.includes('.') ? way.selection.target.split('.')[0] : undefined;
  let seen = 0;
  for (const [key, side] of Object.entries(way.selection.decisions)) {
    const located = locate(key, tree, sources.treeOf);
    const found = located === undefined ? undefined : seenSide(located, run);
    if (found === undefined || found === BOTH) {
      // Not seen where the case hangs on it: the evidence for this case is not there.
      const offAssumed = side !== FAILS && (located === undefined || !isAssumed(located.place.node, side));
      const pastBlock = toBlock !== undefined && toBlock[key] !== side;
      if (offAssumed || pastBlock || key === failingCall) return false;
      continue;
    }
    if (found !== side) return false;
    seen += 1;
  }
  // A choice of no decision (the one way of a pipeline without a branch) has nothing to see: its end running is the evidence.
  if (seen === 0 && Object.keys(way.selection.decisions).length > 0) return false;
  const target = locate(way.selection.target, tree, sources.treeOf);
  if (target === undefined) return false;
  const failure = way.made.failure;
  if (way.made.kind !== 'failure' || failure === undefined) return nodeRan(target, run);
  const thrown = target.place.node;
  if (target.tree.id !== failure.from || thrown.kind !== 'throw' || (thrown.error ?? 'Error') !== failure.error || !nodeRan(target, run)) return false;
  if (!getsUp(way, tree, run, sources)) return false;
  const named = responseError(response);
  if (failure.code !== undefined && named !== undefined && named !== failure.code) return false;
  return response.status >= 400 || (way.made.end === 'error-response' && caught(way, tree, run, sources));
}

/** The first sentence of words (to the first `。`), on one line. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  const end = flat.indexOf('。');
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** A decision and a side in words: the words of its node when it has some (their first sentence), else its code. */
export function conditionOf(node: TreeNode, side: string, step: string | undefined): CaseCondition {
  const words = node.text === undefined || node.text.trim() === '' ? undefined : firstSentence(node.text);
  return { ...(step === undefined ? {} : { step }), text: words ?? node.code.replace(/\s+/g, ' ').trim(), code: words === undefined, side };
}

/** The kinds of node a request is read at: the decisions and the calls (which may fail). */
const READ = new Set(['if', 'switch', 'loop', 'try', 'cond-expr', 'call']);

/** What an endpoint gives the examples of its cases besides the requests. */
export interface EndpointExamples {
  /** The tree of its root frame. */
  tree: FlowTree;
  /** The function of each step that has one (FlowStep.functionId), by step id. */
  stepFunctions: ReadonlyMap<string, string>;
  /** The functions of the catalog a frame calls (MapData.functions[id].calls). */
  callsOf(frame: string): readonly string[];
  /** Whether a test is one of the endpoint's own: its code requests the endpoint. */
  own(test: TestCase): boolean;
}

/** Whether a walk reaches the end of a case: the throw or the failing call of a failure, the node of any other. */
function reaches(walked: FlowWalk, way: CaseWay): boolean {
  const target = way.selection.target;
  if (way.made.kind === 'failure') {
    const first = target.split('.')[0];
    return walked.stops.some((stop) => stop.depth === 0 && stop.node.id === first && (stop.event === 'fails' || stop.event === 'throws'));
  }
  return walked.stops.some((stop) => stop.depth === 0 && stop.node.id === target);
}

/** The request of an example: the path and the query of its URL, and its host. */
function requestOf(exchange: RawExchange): CaseExample['request'] | undefined {
  let url: URL;
  try {
    url = new URL(exchange.request.url);
  } catch {
    return undefined;
  }
  const { method, headers, body, truncated } = exchange.request;
  return { method, path: `${url.pathname}${url.search}`, host: url.host, headers, ...(body === undefined ? {} : { body }), ...(truncated === true ? { truncated } : {}) };
}

/**
 * The example a request makes of a case it took: its endpoint's tree walked
 * along the sides seen at every decision of the root frame and the case's
 * own where none was seen (a `try` seen to catch whose body has the call
 * that failed runs its body up to it), each step with how it went, the
 * decisions seen in it and the functions whose calls in it ran (RequestRun.callRan). Undefined when
 * that walk does not reach the end of the case. `taken` are all the cases
 * the request took: a failure of one names the error of a step that failed.
 */
export function exampleOf(way: CaseWay, taken: readonly CaseWay[], sent: SentRequest, run: RequestRun, endpoint: EndpointExamples): CaseExample | undefined {
  const { tree } = endpoint;
  const response = sent.exchange.response;
  const request = requestOf(sent.exchange);
  if (response === undefined || request === undefined) return undefined;
  const decisions: Decisions = {};
  for (const [key, side] of Object.entries(way.selection.decisions)) if (!key.includes('.')) decisions[key] = side;
  const seen = new Map<string, string>();
  const places = placesOf(tree);
  for (const node of nodesOf(tree.nodes)) {
    const place = places.get(node.id);
    if (!READ.has(node.kind) || place === undefined) continue;
    const side = seenSide({ tree, place }, run);
    if (side === undefined || side === BOTH || side === GOES) continue;
    seen.set(node.id, side);
    decisions[node.id] = side;
  }
  for (const node of nodesOf(tree.nodes)) {
    if (node.kind !== 'try' || decisions[node.id] !== 'catch') continue;
    const body = node.branches?.find((branch) => branch.key === 'try')?.nodes ?? [];
    if ([...nodesOf(body)].some((inner) => inner.kind === 'call' && decisions[inner.id] === FAILS)) delete decisions[node.id];
  }
  const walked = walkFlow(tree, decisions);
  if (!reaches(walked, way)) return undefined;
  const errorAt = (step: string): string | undefined => {
    if (way.made.failure?.step === step) return way.made.failure.error;
    const errors = new Set(taken.flatMap((other) => (other.made.kind === 'failure' && other.made.failure?.step === step ? [other.made.failure.error] : [])));
    return errors.size === 1 ? [...errors][0] : undefined;
  };
  const steps: ExampleStep[] = stepsOf(walked).map((id) => ({ id, how: 'ran' }));
  const byId = new Map(steps.map((step) => [step.id, step]));
  let catching = false;
  for (const stop of walked.stops) {
    // A return answers from the step of the last stepped call it returns the result of (`return respond(c, await process(c))` outside the steps, a step's `return issueAuthorizationCodeResponse(…)`), else from its own step.
    const answering = stop.event === 'returns' ? [...nodesOf(stop.node.pre ?? [])].reverse().find((node) => node.step !== undefined && byId.has(node.step.id))?.step?.id : undefined;
    const step = byId.get(answering ?? stop.step ?? '');
    if (stop.event === 'catches') {
      if (step === undefined) catching = true;
      else step.how = 'caught';
      continue;
    }
    if (step === undefined) continue;
    if (catching) {
      step.how = 'caught';
      catching = false;
    }
    if (stop.event === 'fails' || stop.event === 'throws') {
      step.how = 'failed';
      const error = stop.error ?? errorAt(step.id);
      if (error !== undefined) step.error = error;
    } else if (stop.event === 'returns' && step.how === 'ran') step.how = 'answered';
    if (stop.side !== undefined && seen.get(stop.node.id) === stop.side.key && stop.node.kind !== 'call') {
      step.decisions = [...(step.decisions ?? []), conditionOf(stop.node, stop.side.label, step.id)];
    }
  }
  for (const step of steps) {
    if (step.how !== 'failed') delete step.error;
    const fn = endpoint.stepFunctions.get(step.id);
    const catalog = fn === undefined ? undefined : new Set(endpoint.callsOf(fn));
    const ran =
      fn !== undefined
        ? run.calledBy(fn).filter((frame) => catalog?.has(frame) === true)
        : walked.stops.flatMap((stop) => (stop.depth === 0 && stop.step === step.id && stop.node.kind === 'call' && stop.node.target?.kind === 'function' && run.callRan(tree, stop.node) ? [stop.node.target.id] : []));
    const calls = [...new Set(ran)];
    if (calls.length > 0) step.calls = calls;
  }
  const { status, statusText, headers, body, truncated } = response;
  return {
    test: sent.test.id,
    request,
    response: { status, ...(statusText === undefined || statusText === '' ? {} : { statusText }), headers, ...(body === undefined ? {} : { body }), ...(truncated === true ? { truncated } : {}) },
    steps,
  };
}

/** How big a request is to read: the bytes of its headers and its body. */
function sizeOf(exchange: RawExchange): number {
  const headers = exchange.request.headers.reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value), 0);
  return headers + Buffer.byteLength(exchange.request.body ?? '');
}

/** What joining the requests of an endpoint to its cases saw. */
export interface ExampleCounts {
  /** The requests read: those overlapped by another or without a response left out. */
  read: number;
  /** Of those, the ones that took a case. */
  took: number;
}

/**
 * Give the cases of an endpoint the requests that took them (see the module
 * comment): each case its examples, the tests of the endpoint's own first,
 * then the smaller requests, one of each method, path and body, at most
 * EXAMPLES, and how many requests took it in all.
 */
export function attachExamples(ways: readonly CaseWay[], requests: readonly SentRequest[], endpoint: EndpointExamples, sources: CaseSources): ExampleCounts {
  const found = new Map<CaseWay, Array<{ sent: SentRequest; example: CaseExample; order: number }>>();
  const counts: ExampleCounts = { read: 0, took: 0 };
  requests.forEach((sent, order) => {
    const { response, overlapped, error } = sent.exchange;
    if (response === undefined || overlapped === true || error !== undefined) return;
    counts.read += 1;
    const run = new RequestRun(sent.exchange, sources);
    const taken = ways.filter((way) => takes(way, endpoint.tree, run, response, sources));
    let took = false;
    for (const way of taken) {
      const example = exampleOf(way, taken, sent, run, endpoint);
      if (example === undefined) continue;
      found.set(way, [...(found.get(way) ?? []), { sent, example, order }]);
      took = true;
    }
    if (took) counts.took += 1;
  });
  for (const way of ways) {
    const list = found.get(way);
    if (list === undefined) continue;
    const ranked = [...list].sort((a, b) => Number(!endpoint.own(a.sent.test)) - Number(!endpoint.own(b.sent.test)) || sizeOf(a.sent.exchange) - sizeOf(b.sent.exchange) || (a.sent.test.id < b.sent.test.id ? -1 : a.sent.test.id > b.sent.test.id ? 1 : 0) || a.order - b.order);
    const kept = new Set<string>();
    const examples: CaseExample[] = [];
    for (const { example } of ranked) {
      const key = [example.request.method, example.request.path, example.request.body ?? ''].join('\u0000');
      if (kept.has(key)) continue;
      kept.add(key);
      examples.push(example);
      if (examples.length === EXAMPLES) break;
    }
    way.made.examples = examples;
    way.made.exampleCount = list.length;
  }
  return counts;
}

/**
 * The requests of the measured tests by endpoint, `<source>:<endpoint>`: a
 * request of a test of hono goes to the endpoint of hono whose path its URL
 * has (`endpointOf`), and so for Next.js; the tests of any other root send
 * none to an endpoint of a source.
 */
export function requestsByEndpoint(exchanges: ReadonlyMap<string, readonly RawExchange[]>, tests: ReadonlyMap<string, TestCase>, endpointOf: (source: 'hono' | 'nextjs', path: string) => string | undefined): Map<string, SentRequest[]> {
  const byEndpoint = new Map<string, SentRequest[]>();
  for (const [id, list] of exchanges) {
    const test = tests.get(id);
    const source = test?.root === 'hono' || test?.root === 'nextjs' ? test.root : undefined;
    if (test === undefined || source === undefined) continue;
    for (const exchange of list) {
      let path: string;
      try {
        path = new URL(exchange.request.url).pathname;
      } catch {
        continue;
      }
      const endpoint = endpointOf(source, path);
      if (endpoint === undefined) continue;
      const key = `${source}:${endpoint}`;
      byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), { test, exchange }]);
    }
  }
  return byEndpoint;
}
