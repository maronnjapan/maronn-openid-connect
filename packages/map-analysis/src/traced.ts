/**
 * The reading of a traced request: the order of what ran while the live OP
 * answered one request (packages/live-op: one probe a time a statement, a
 * branch side or a function's entry counted, in order), read against the
 * frames of the map, to tell what each call of the request did and the side
 * each decision took in it.
 *
 * The counters of a request (observe.ts) tell how often each place ran; the
 * order tells in which call. A function's entry starts an invocation of its
 * frame; what runs on its lines after belongs to the latest invocation of
 * that frame; the invocation that called it is the latest one whose frame
 * calls it (the catalog's `calls`), else the one that ran last (and that
 * one when code outside the frames of the map ran right before; the one
 * that ran a `throw` right before, whose expression calls it). Each
 * invocation then has counters of its own, and the rules of observe.ts read
 * them as they read a whole request's, so a function called twice, or a
 * decision taken one way in one call and the other in another, reads apart.
 *
 * - The default values of its parameters run just before a function's entry
 *   is counted: those right before it are its own.
 * - A function that is no frame of the map (a callback, a closure) runs in
 *   the frame whose lines it is on. When that frame's latest invocation is
 *   running (it ran last, or what ran last is below it), it is a callback of
 *   that invocation (`map`, `forEach`, `then`, a local function: the tree
 *   puts them in the frame), and what it runs is that invocation's. Else it
 *   is a closure the frame made, called later (an issuer's `issue` made by
 *   its factory): an anonymous invocation of the frame under what called
 *   it, which is never a root and never made by a call node of the frame;
 *   or, for an endpoint body that has not run, the handler of one of its
 *   routes: the body, called from outside.
 *
 * An invocation threw when what it ran last was a `throw` (the probe table
 * marks them; what the `throw` calls to make its error runs after it), a
 * call that threw, or a statement that is no `return` after which nothing
 * ran when the node after it in its tree did not run (what it called
 * outside the map threw: `atob`, `JSON.parse`); and a call threw when the
 * `try` of its caller around it caught right after it. A call of a frame
 * whose invocation threw fails, wherever it is in its list: the rules that
 * look at the next node cannot tell a call that ends its list. A statement
 * an invocation left in the middle for a catch, or for nothing, fails too.
 *
 * A frame of the map is named by its key, the call nodes from the root
 * down (`s0b1s0.s2`); the invocation of a key is the one its call node
 * made (callsOf). The invocations a parent made of one function go to its
 * call nodes of that function in the order they are evaluated, each to the
 * first one not taken yet in the statement that called it, so the calls of
 * one statement (`optional()` eight times in one `return { … }`) go to
 * their nodes one by one; a call made again by the same statement run
 * again (a loop) takes no other node; a call from a statement with no such
 * node came from a local function the tree puts on the lines of its call,
 * or from code outside the map, which no node made.
 *
 * The decisions of an invocation are the rules' (observe.ts); a decision a
 * loop took both ways reads as the last time it ran; a decision the rules
 * cannot tell takes the one side whose calls of the map ran, or, where it
 * ran, the one side that does not start with a call of the map that did
 * not run; a callback's loop takes its body when the invocation entered a
 * function on its lines, else it is skipped; a call of the map in what a
 * node evaluates first (`a && f()`) that did not run where its node ran is
 * not evaluated (SKIPS).
 *
 * This module imports only types, observe.ts and walk.ts, so the page uses
 * it as it is: `@maronn-openid-connect/map-analysis/traced`.
 */
import type { Decisions, FlowTree, MapData, Selection, TreeNode } from './model.js';
import { BOTH, GOES, nextOf, nodeRan, observable, placesOf, RequestRun, seenDecisions, seenSide, throughTries, type Place, type RanInFile, type RunSources } from './observe.js';
import { FAILS, nodesOf, SKIPS, walkFlow, type FlowWalk } from './walk.js';

/** The probes of one build of the live OP (packages/live-op api.ts ProbeTable). */
export interface TraceProbes {
  hash: string;
  files: string[];
  types: string[];
  names: string[];
  probes: Array<[number, number, number, number, number?, number?, number?]>;
}

/** What one request ran, in order (packages/live-op api.ts TraceEvents). */
export interface TraceRun {
  probes: string;
  events: number[];
  truncated?: true;
}

const STATEMENT = 0;
const BRANCH = 1;
const FUNCTION = 2;
const THROWS = 1;
const RETURNS = 2;

/** The decisions whose side a call of the map on one side tells. */
const SIDED: ReadonlySet<string> = new Set(['if', 'cond-expr', 'switch', 'loop']);

/** The decisions the rules read (the calls aside). */
const READ: ReadonlySet<string> = new Set(['if', 'switch', 'loop', 'try', 'cond-expr']);

/** A frame of the map as the reading places a probe in it. */
interface Frame {
  id: string;
  path: string;
  start: number;
  end: number;
  /** The line of its declaration, where its entry is counted. */
  line: number;
  calls: ReadonlySet<string>;
  /** An endpoint body: the handlers of its routes, each a function of its own lines, are its entries. */
  body: boolean;
}

/** The frames of the map by the repository path of their file, to place a probe in the innermost one. */
export class FrameCatalog {
  private readonly byPath = new Map<string, Frame[]>();
  private readonly byId = new Map<string, Frame>();

  constructor(data: Pick<MapData, 'functions' | 'bodies' | 'sources'>) {
    const bodies = new Set(Object.keys(data.bodies));
    for (const entry of [...Object.values(data.functions), ...Object.values(data.bodies)]) {
      if (entry.source === undefined) continue;
      const path = data.sources[entry.source.file]?.path;
      if (path === undefined) continue;
      const frame: Frame = { id: entry.id, path, start: entry.source.start, end: entry.source.end, line: entry.line, calls: new Set(entry.calls), body: bodies.has(entry.id) };
      this.byPath.set(path, [...(this.byPath.get(path) ?? []), frame]);
      this.byId.set(entry.id, frame);
    }
  }

  /** The innermost frame a line of a file is in. */
  frameAt(path: string, line: number): Frame | undefined {
    let best: Frame | undefined;
    for (const frame of this.byPath.get(path) ?? []) {
      if (line < frame.start || line > frame.end) continue;
      if (best === undefined || frame.end - frame.start < best.end - best.start) best = frame;
    }
    return best;
  }

  /** A frame by id. */
  frame(id: string): Frame | undefined {
    return this.byId.get(id);
  }
}

/** One call of a frame while the request was answered. */
export interface Invocation {
  index: number;
  frame: string;
  /** The invocation that called it; undefined for one called from outside the frames of the map (the router, the middleware). */
  parent?: number;
  children: number[];
  /** The index of its entry among the events (-1 for one whose entry was not seen). */
  start: number;
  /** The indexes of the events of its own lines, in order (the default values of its parameters, counted before its entry, first). */
  events: number[];
  /** The line of its parent's last own event before it was called: the line of the call. */
  callLine?: number;
  /** The index of that event: the run of the statement that called it. */
  callEvent?: number;
  /** A closure its frame made, run later from elsewhere (see the module comment): no call node of its frame made it, and it is no root. */
  anonymous?: true;
}

/** Whether a node calls a function of the catalog. */
function callsFunction(node: TreeNode): node is TreeNode & { target: { kind: 'function'; id: string } } {
  return node.kind === 'call' && node.target?.kind === 'function';
}

/** The nodes of a tree in the order they are evaluated: what a node evaluates first (its pre), the node, then its sides. */
function* evaluationOrder(nodes: readonly TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    if (node.pre !== undefined) yield* evaluationOrder(node.pre);
    yield node;
    for (const branch of node.branches ?? []) yield* evaluationOrder(branch.nodes);
  }
}

/** The key a choice gives a node of a frame (`''` the root). */
function keyIn(frame: string, node: string): string {
  return frame === '' ? node : `${frame}.${node}`;
}

/** The place of the owner of a place's list; undefined for the body of the frame. */
function ownerPlace(tree: FlowTree, place: Place): Place | undefined {
  return place.owner === undefined ? undefined : placesOf(tree).get(place.owner.id);
}

/** The statement a node is in: the node itself, or the node whose pre (whose pre's pre, …) holds it. */
function statementOf(tree: FlowTree, place: Place): Place | undefined {
  let at: Place | undefined = place;
  while (at !== undefined && at.pre) at = ownerPlace(tree, at);
  return at;
}

/** Whether a node is in what another evaluates first, or in a pre's side: not a statement of its own. */
function inExpression(tree: FlowTree, place: Place): boolean {
  for (let at: Place | undefined = place; at !== undefined; at = ownerPlace(tree, at)) if (at.pre) return true;
  return false;
}

const HOLDERS = new WeakMap<FlowTree, Map<number, Place | undefined>>();

/** The statement on a line: the innermost node on it that is no part of an expression and has lines of its own (kept by tree). */
function holderOf(tree: FlowTree, line: number): Place | undefined {
  let known = HOLDERS.get(tree);
  if (known === undefined) {
    known = new Map();
    HOLDERS.set(tree, known);
  }
  if (known.has(line)) return known.get(line);
  let best: Place | undefined;
  for (const place of placesOf(tree).values()) {
    const { node } = place;
    if (line < node.lines[0] || line > node.lines[1] || place.inlined || inExpression(tree, place)) continue;
    if (best === undefined || node.lines[1] - node.lines[0] <= best.node.lines[1] - best.node.lines[0]) best = place;
  }
  known.set(line, best);
  return best;
}

/** The `try` with a catch (an empty one too) whose body holds a node, the innermost one; undefined for none. */
function catchAround(tree: FlowTree, place: Place): { node: TreeNode; body: readonly TreeNode[]; handler: readonly TreeNode[] } | undefined {
  for (let at: Place | undefined = place; at !== undefined; at = ownerPlace(tree, at)) {
    const owner = at.owner;
    if (owner?.kind !== 'try' || at.pre) continue;
    const body = owner.branches?.find((branch) => branch.key === 'try');
    const handler = owner.branches?.find((branch) => branch.key === 'catch');
    if (body !== undefined && body.nodes === at.list && handler !== undefined) return { node: owner, body: body.nodes, handler: handler.nodes };
  }
  return undefined;
}

/** Whether a line is on the lines of some nodes. */
function onLines(line: number, nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => line >= node.lines[0] && line <= node.lines[1]);
}

/** Whether a node is in a feature that is off (it, or a node it is in, of a feature not among those enabled). */
function featureOff(tree: FlowTree, place: Place, enabled: ReadonlySet<string> | undefined): boolean {
  if (enabled === undefined) return false;
  for (let at: Place | undefined = place; at !== undefined; at = ownerPlace(tree, at)) if (at.node.feature !== undefined && !enabled.has(at.node.feature)) return true;
  return false;
}

/** What a request ran, read into invocations (see the module comment). */
export class RequestTrace {
  readonly invocations: Invocation[] = [];
  /** Whether each invocation threw, by the trees it was read with (none: by the probes alone). */
  private readonly threwMemo = new Map<unknown, Map<number, boolean>>();
  /** The call nodes each invocation made its calls from, for the tree it was read with. */
  private readonly callsMemo = new Map<number, { tree: FlowTree; calls: Map<string, Invocation> }>();
  /** The decisions read of each frame key of a root, for the trees and the sources they were read with. */
  private readonly decidedMemo = new Map<string, { root: FlowTree; tree: FlowTree; sources: RunSources; decisions: Decisions }>();

  constructor(
    readonly run: TraceRun,
    readonly table: TraceProbes,
    readonly catalog: FrameCatalog,
  ) {
    const frameOf = new Map<number, Frame | null>();
    const placeOf = (probe: number): Frame | undefined => {
      let frame = frameOf.get(probe);
      if (frame === undefined) {
        const entry = table.probes[probe];
        const path = entry === undefined ? undefined : table.files[entry[0]];
        frame = entry === undefined || path === undefined || entry[2] === 0 ? null : (catalog.frameAt(path, entry[2]) ?? null);
        frameOf.set(probe, frame);
      }
      return frame ?? undefined;
    };
    /** Whether a probe is the entry of a frame: a function's, on the line of the frame's declaration. */
    const isEntry = (probe: number, frame: Frame | undefined): boolean => {
      const entry = table.probes[probe];
      return frame !== undefined && entry !== undefined && entry[1] === FUNCTION && entry[2] === frame.line;
    };
    // The default values of a function's parameters run right before its entry is counted: they are its own.
    const defaultArg = table.types.indexOf('default-arg');
    const beforeEntry = new Map<number, number>();
    run.events.forEach((probe, at) => {
      const frame = placeOf(probe);
      if (frame === undefined || !isEntry(probe, frame)) return;
      for (let back = at - 1; back >= 0; back -= 1) {
        const earlier = run.events[back] ?? -1;
        const entry = table.probes[earlier];
        if (entry === undefined || entry[1] !== BRANCH || entry[4] !== defaultArg || placeOf(earlier) !== frame) break;
        beforeEntry.set(back, at);
      }
    });
    const pending = new Map<number, number[]>();
    const latest = new Map<string, number>();
    /** The invocations in the order they last ran, the latest last. */
    const recent: number[] = [];
    const touch = (index: number): void => {
      const at = recent.lastIndexOf(index);
      if (at >= 0) recent.splice(at, 1);
      recent.push(index);
    };
    const lastEvent = new Map<number, number>();
    /** The last event an invocation ran on its own lines, and that invocation. */
    let owned: { at: number; owner: number } | undefined;
    /** Whether an invocation is running when another ran last: it is that one, or that one is below it. */
    const running = (index: number, last: number | undefined): boolean => {
      for (let at = last; at !== undefined; at = this.invocations[at]?.parent) if (at === index) return true;
      return false;
    };
    /** A new invocation of a frame called by a parent (none for one called from outside the map). */
    const begin = (frame: string, parent: number | undefined, start: number, events: number[], anonymous: boolean): void => {
      const callEvent = parent === undefined ? undefined : lastEvent.get(parent);
      const callProbe = callEvent === undefined ? undefined : table.probes[run.events[callEvent] ?? -1];
      const invocation: Invocation = {
        index: this.invocations.length,
        frame,
        ...(parent === undefined ? {} : { parent }),
        children: [],
        start,
        events,
        ...(callProbe === undefined ? {} : { callLine: callProbe[2], callEvent }),
        ...(anonymous ? { anonymous: true as const } : {}),
      };
      this.invocations.push(invocation);
      if (parent !== undefined) this.invocations[parent]?.children.push(invocation.index);
      latest.set(frame, invocation.index);
      touch(invocation.index);
    };
    run.events.forEach((probe, at) => {
      const frame = placeOf(probe);
      if (frame === undefined) return;
      const entry = table.probes[probe];
      if (entry === undefined) return;
      const entryAt = beforeEntry.get(at);
      if (entryAt !== undefined) {
        pending.set(entryAt, [...(pending.get(entryAt) ?? []), at]);
        return;
      }
      if (isEntry(probe, frame)) {
        // The event before the call, the default values of its parameters aside.
        const callAt = Math.min(at, ...(pending.get(at) ?? [])) - 1;
        const before = table.probes[run.events[callAt] ?? -1];
        // Right after a `throw` an invocation ran: its expression makes the error (`throw invalidToken()`, a function it was given).
        let parent = before?.[1] === STATEMENT && before[4] === THROWS && owned?.at === callAt ? owned.owner : undefined;
        // Right after code outside the frames of the map ran (a handler of a table, a store's method): what ran last called that code.
        if (parent === undefined && before !== undefined && before[2] > 0 && placeOf(run.events[callAt] ?? -1) === undefined) parent = recent[recent.length - 1];
        // Else the latest invocation whose frame calls this one, else the one that ran last.
        for (let back = parent === undefined ? recent.length - 1 : -1; back >= 0; back -= 1) {
          const candidate = this.invocations[recent[back] ?? -1];
          if (candidate !== undefined && catalog.frame(candidate.frame)?.calls.has(frame.id)) {
            parent = candidate.index;
            break;
          }
        }
        parent ??= recent[recent.length - 1];
        begin(frame.id, parent, at, pending.get(at) ?? [], false);
        return;
      }
      const last = recent[recent.length - 1];
      let owner = latest.get(frame.id);
      if (entry[1] === FUNCTION && owner === undefined && frame.body) {
        // The handler of another route of an endpoint body that has not run: the body, called from outside.
        begin(frame.id, undefined, at, [], false);
        return;
      }
      if (entry[1] === FUNCTION && (owner === undefined || !running(owner, last))) {
        // A function of no frame whose frame is not running: a closure it made, called from what ran last.
        begin(frame.id, last, at, [], true);
        return;
      }
      if (owner === undefined) {
        // Lines of a frame whose entry was not seen: an invocation of its own, called from outside.
        owner = this.invocations.length;
        this.invocations.push({ index: owner, frame: frame.id, children: [], start: -1, events: [] });
        latest.set(frame.id, owner);
      }
      this.invocations[owner]?.events.push(at);
      lastEvent.set(owner, at);
      owned = { at, owner };
      touch(owner);
    });
  }

  /** The probe of an event. */
  private probeAt(event: number): TraceProbes['probes'][number] | undefined {
    return this.table.probes[this.run.events[event] ?? -1];
  }

  /** The children of an invocation, in the order they started. */
  private childrenOf(invocation: Invocation): Invocation[] {
    return invocation.children
      .map((child) => this.invocations[child])
      .filter((child): child is Invocation => child !== undefined)
      .sort((a, b) => a.start - b.start);
  }

  /**
   * The call nodes of a frame's tree an invocation of it made its calls
   * from, each with the invocation it made (see the module comment): its
   * calls of a function go to the call nodes of that function in the order
   * they are evaluated, each to the first not taken yet in the statement
   * that called it, on or after the line of that call (preferring those that
   * start by the line of the statement the invocation ran next). A call from a
   * statement with no such node came from a local function the tree puts on
   * the lines of its call (it goes to a node there), else from code outside
   * the map that the statement called (it takes none); a call made again by
   * a run again of the statement that made one (a loop) takes none.
   */
  callsOf(invocation: Invocation, tree: FlowTree): ReadonlyMap<string, Invocation> {
    const known = this.callsMemo.get(invocation.index);
    if (known !== undefined && known.tree === tree) return known.calls;
    const places = placesOf(tree);
    const inlined = (node: TreeNode) => places.get(node.id)?.inlined === true;
    const byCallee = new Map<string, TreeNode[]>();
    for (const node of evaluationOrder(tree.nodes)) if (callsFunction(node)) byCallee.set(node.target.id, [...(byCallee.get(node.target.id) ?? []), node]);
    const calls = new Map<string, Invocation>();
    /** By function: the probe of each statement that called it, and the run of it that did. */
    const callers = new Map<string, Map<number, number>>();
    for (const child of this.childrenOf(invocation)) {
      const nodes = byCallee.get(child.frame);
      if (nodes === undefined || child.anonymous === true) continue;
      if (child.callEvent !== undefined) {
        const probe = this.run.events[child.callEvent] ?? -1;
        const seen = callers.get(child.frame) ?? new Map<number, number>();
        callers.set(child.frame, seen);
        const earlier = seen.get(probe);
        // The statement that made an earlier call ran again: a loop calls the same node again.
        if (earlier !== undefined && earlier !== child.callEvent) continue;
        seen.set(probe, child.callEvent);
      }
      const low = child.callLine;
      const holder = low === undefined ? undefined : holderOf(tree, low);
      let fitting = nodes.filter((node) => !inlined(node) && (low === undefined || node.lines[1] >= low) && (holder === undefined || (node.lines[0] >= holder.node.lines[0] && node.lines[1] <= holder.node.lines[1])));
      if (fitting.length > 0) {
        // (A branch is counted at the start of its expression: only a statement tells where the invocation went on.)
        const next = invocation.events.find((event) => event > child.start && this.probeAt(event)?.[1] === STATEMENT);
        const nextLine = next === undefined ? undefined : this.probeAt(next)?.[2];
        const bounded = nextLine === undefined ? [] : fitting.filter((node) => node.lines[0] <= nextLine);
        if (bounded.length > 0) fitting = bounded;
      } else {
        // A local function the tree puts on the lines of its call: the node there, at the statement that called the local function.
        fitting = this.callSites(invocation, child).map((site) => nodes.filter((node) => inlined(node) && site >= node.lines[0] && site <= node.lines[1])).find((found) => found.length > 0) ?? [];
      }
      const free = fitting.find((node) => !calls.has(node.id));
      if (free !== undefined) calls.set(free.id, child);
    }
    this.callsMemo.set(invocation.index, { tree, calls });
    return calls;
  }

  /** The lines of the statements of an invocation that called the functions of no frame it ran before a child started (its local functions), the latest first. */
  private callSites(invocation: Invocation, child: Invocation): number[] {
    const sites: number[] = [];
    const own = invocation.events.filter((event) => event < child.start);
    for (let at = own.length - 1; at > 0 && sites.length < 8; at -= 1) {
      if (this.probeAt(own[at] ?? -1)?.[1] !== FUNCTION) continue;
      const line = this.probeAt(own[at - 1] ?? -1)?.[2];
      if (line !== undefined) sites.push(line);
    }
    return sites;
  }

  /**
   * Whether an invocation threw (see the module comment): what it ran last
   * was a `throw`, or a call that threw (its last child started after its
   * own last event); with the trees, also a statement that is no `return`
   * after which nothing ran, when the node after it did not run, and a call
   * the `try` of its caller around it caught right after it.
   */
  threw(index: number, treeOf?: (id: string) => FlowTree | undefined): boolean {
    let memo = this.threwMemo.get(treeOf);
    if (memo === undefined) {
      memo = new Map();
      this.threwMemo.set(treeOf, memo);
    }
    const known = memo.get(index);
    if (known !== undefined) return known;
    memo.set(index, false);
    const invocation = this.invocations[index];
    const threw = invocation !== undefined && (this.threwItself(invocation, treeOf) || (treeOf !== undefined && this.caught(invocation, treeOf)));
    memo.set(index, threw);
    return threw;
  }

  /** Whether an invocation threw by what it ran itself (threw, but for its caller's catch). */
  private threwItself(invocation: Invocation, treeOf: ((id: string) => FlowTree | undefined) | undefined): boolean {
    const last = Math.max(invocation.events[invocation.events.length - 1] ?? -1, invocation.start);
    const probe = this.probeAt(last);
    // A `throw` counts before its expression runs (`throw invalidClient()` calls after it): it ends the invocation whatever it calls.
    if (probe !== undefined && probe[1] === STATEMENT && probe[4] === THROWS) return true;
    const lastChild = this.childrenOf(invocation).pop();
    if (lastChild !== undefined && lastChild.start > last) return this.threw(lastChild.index, treeOf);
    // (A closure's statements are none of its frame's tree.)
    if (treeOf === undefined || invocation.anonymous === true || probe === undefined || probe[1] !== STATEMENT) return false;
    const tree = treeOf(invocation.frame);
    // A callback of what a `throw` evaluates ran last: the `throw` ends the frame.
    if (tree === undefined || holderOf(tree, probe[2])?.node.kind === 'throw') return tree !== undefined;
    // A statement after which nothing ran: what it called outside the map threw, when the node after it did not run.
    return this.cutAt(tree, last, undefined) !== undefined;
  }

  /**
   * The statement an invocation left in the middle (what it called outside
   * the map threw there): its own statement `event`, and `next`, its next
   * own event past that statement (undefined when it ran nothing more).
   * Ran nothing more: the node after the statement in the tree did not run
   * (no `return`, `throw`, `continue` or `break`, nor the end of a loop's
   * body, a `try`'s body, a clause). Went on in the catch of a `try` around
   * it; or past a `try` around it whose catch is empty, the node after it in
   * the body not run. Undefined for a statement left as it reads.
   */
  private cutAt(tree: FlowTree, event: number, next: number | undefined): Place | undefined {
    const probe = this.probeAt(event);
    if (probe === undefined || probe[1] !== STATEMENT || probe[4] === THROWS) return undefined;
    const holder = holderOf(tree, probe[2]);
    if (holder === undefined || /^(?:continue|break)\b/.test(holder.node.code) || holder.node.kind === 'throw') return undefined;
    const returns = probe[4] === RETURNS || holder.node.kind === 'return';
    const after = nextOf(tree, holder);
    const followed = after !== undefined && after.lines[1] > holder.node.lines[1];
    if (next === undefined) return !returns && followed ? holder : undefined;
    const around = catchAround(tree, holder);
    if (around === undefined) return undefined;
    const line = this.probeAt(next)?.[2] ?? 0;
    if (around.handler.length > 0) return onLines(line, around.handler) ? holder : undefined;
    const past = line < around.node.lines[0] || line > around.node.lines[1];
    return !returns && past && followed && onLines(after.lines[0], around.body) ? holder : undefined;
  }

  /**
   * Whether the `try` of an invocation's caller around its call node caught
   * right after it: the call was the last thing that ran in its body (no
   * other call started, and no statement of the body ran, after it) before
   * the catch ran.
   */
  private caught(invocation: Invocation, treeOf: (id: string) => FlowTree | undefined): boolean {
    const parent = this.invocations[invocation.parent ?? -1];
    const tree = parent === undefined ? undefined : treeOf(parent.frame);
    if (parent === undefined || tree === undefined || invocation.anonymous === true) return false;
    const id = [...this.callsOf(parent, tree)].find(([, child]) => child === invocation)?.[0];
    const place = id === undefined ? undefined : placesOf(tree).get(id);
    const around = place === undefined ? undefined : catchAround(tree, place);
    if (place === undefined || around === undefined) return false;
    const lineOf = (event: number) => this.probeAt(event)?.[2] ?? 0;
    const isStatement = (event: number) => this.probeAt(event)?.[1] === STATEMENT;
    const caughtAt = parent.events.find((event) => event > invocation.start && isStatement(event) && onLines(lineOf(event), around.handler));
    if (caughtAt === undefined) return false;
    if (parent.children.some((child) => child !== invocation.index && (this.invocations[child]?.start ?? -1) > invocation.start && (this.invocations[child]?.start ?? -1) < caughtAt)) return false;
    // What ran of the body in between on the lines of the call is a callback the call ran; anything else ran after it returned.
    return !parent.events.some((event) => event > invocation.start && event < caughtAt && isStatement(event) && onLines(lineOf(event), around.body) && !onLines(lineOf(event), [place.node]));
  }

  /** The invocations of a root's frame that were called from outside the frames of the map, in order, those whose entry was seen first: the endpoint body the router ran. */
  private rootsOf(rootId: string): Invocation[] {
    const found = this.invocations.filter((invocation) => invocation.frame === rootId && invocation.anonymous !== true);
    return [...found.filter((invocation) => invocation.start >= 0), ...found.filter((invocation) => invocation.start < 0)];
  }

  /**
   * The invocation a frame key of a root names (`''` the root itself),
   * following the call nodes of the key through the trees (callsOf); for a
   * root made from the endpoint's handlers (synthetic), its handlers are its
   * calls. Undefined when the request did not run it.
   */
  invocationAt(root: FlowTree, key: string, treeOf: (id: string) => FlowTree | undefined): Invocation | undefined {
    let tree = root;
    let invocation: Invocation | undefined = root.synthetic === true ? undefined : this.rootsOf(root.id)[0];
    if (key === '') return invocation;
    const ids = key.split('.');
    for (const [at, id] of ids.entries()) {
      const node = placesOf(tree).get(id)?.node;
      if (node === undefined || !callsFunction(node)) return undefined;
      if (invocation !== undefined) invocation = this.callsOf(invocation, tree).get(node.id);
      else if (tree === root && root.synthetic === true) invocation = this.rootsOf(node.target.id)[0];
      if (invocation === undefined) return undefined;
      if (at === ids.length - 1) break;
      const next = treeOf(node.target.id);
      if (next === undefined) return undefined;
      tree = next;
    }
    return invocation;
  }

  /** Whether the request ran the root at all (a request the router or the middleware answered did not). */
  rootRan(root: FlowTree): boolean {
    if (root.synthetic === true) return [...nodesOf(root.nodes)].some((node) => callsFunction(node) && this.rootsOf(node.target.id).length > 0);
    return this.rootsOf(root.id).length > 0;
  }

  /**
   * What an invocation ran, as the counters of a request (RanInFile by
   * repository path): its own statements and branch sides, and the entries
   * of the functions it called. With `last`, a branch counts only the last
   * time it was taken (a `??`, `||` or `&&` from the last time its left
   * operand ran): a decision taken both ways in a loop reads as it was left.
   */
  ranOf(invocation: Invocation, last = false): Record<string, RanInFile> {
    const files = new Map<string, { s: Map<string, [number, number, number]>; b: Map<string, { place: [number, number, string, number]; sides: number[] }>; f: Map<number, [number, string] | [number]> }>();
    const fileOf = (path: string) => {
      let file = files.get(path);
      if (file === undefined) {
        file = { s: new Map(), b: new Map(), f: new Map() };
        files.set(path, file);
      }
      return file;
    };
    const entryOf = (probe: TraceProbes['probes'][number]) => {
      const [, , line] = probe;
      const name = this.table.names[probe[4] ?? -1];
      return name === undefined ? ([line] as [number]) : ([line, name] as [number, string]);
    };
    for (const event of invocation.events) {
      const probe = this.probeAt(event);
      const path = probe === undefined ? undefined : this.table.files[probe[0]];
      if (probe === undefined || path === undefined) continue;
      const file = fileOf(path);
      const [, kind, line, column] = probe;
      if (kind === STATEMENT) {
        const key = `${line}:${column}`;
        const known = file.s.get(key);
        file.s.set(key, [line, column, (known?.[2] ?? 0) + 1]);
      } else if (kind === BRANCH) {
        const type = this.table.types[probe[4] ?? -1] ?? '';
        const sides = probe[6] ?? 0;
        const key = `${line}:${column}:${type}:${sides}`;
        const known = file.b.get(key) ?? { place: [line, column, type, sides], sides: [] };
        known.sides.push(probe[5] ?? 0);
        file.b.set(key, known);
      } else if (kind === FUNCTION) {
        file.f.set(line, entryOf(probe));
      }
    }
    for (const child of this.childrenOf(invocation)) {
      const probe = child.start < 0 || child.anonymous === true ? undefined : this.probeAt(child.start);
      const path = probe === undefined ? undefined : this.table.files[probe[0]];
      if (probe !== undefined && path !== undefined) fileOf(path).f.set(probe[2], entryOf(probe));
    }
    const ran: Record<string, RanInFile> = {};
    for (const [path, file] of files) {
      const byPlace = (a: readonly [number, number, ...unknown[]], b: readonly [number, number, ...unknown[]]) => a[0] - b[0] || a[1] - b[1];
      const branches = [...file.b.values()].map(({ place: [line, column, type, count], sides }): [number, number, string, number[]] => {
        const taken = !last ? sides : type === 'binary-expr' ? sides.slice(Math.max(0, sides.lastIndexOf(0))) : sides.slice(-1);
        const increments = Array.from({ length: count }, () => 0);
        for (const side of taken) increments[side] = (increments[side] ?? 0) + 1;
        return [line, column, type, increments];
      });
      ran[path] = { s: [...file.s.values()].sort(byPlace), b: branches.sort(byPlace), f: [...file.f.values()].sort((a, b) => a[0] - b[0]) };
    }
    return ran;
  }

  /**
   * The sides a frame took in the invocation its key names: the decisions
   * the rules of observe.ts read from the invocation's own counters, a
   * decision read both ways as the last time it was taken, one they cannot
   * tell on the one side whose calls of the map ran, its calls of frames
   * that threw failing and the others going on (and the call the catch of a
   * `try` came right after, when no call of the map fails there), the calls
   * of the map it did not evaluate where their statement ran skipped
   * (SKIPS), through the tries whose body has a call that failed
   * (throughTries). None for a frame the request did not run.
   */
  decisionsOf(root: FlowTree, key: string, tree: FlowTree, sources: RunSources): Decisions {
    const memoKey = `${root.id}\n${key}`;
    const known = this.decidedMemo.get(memoKey);
    if (known !== undefined && known.root === root && known.tree === tree && known.sources === sources) return known.decisions;
    const decisions = this.decide(root, key, tree, sources);
    this.decidedMemo.set(memoKey, { root, tree, sources, decisions });
    return decisions;
  }

  /** The reading of decisionsOf. */
  private decide(root: FlowTree, key: string, tree: FlowTree, sources: RunSources): Decisions {
    const invocation = this.invocationAt(root, key, sources.treeOf);
    if (invocation === undefined) return root.synthetic === true && key === '' ? this.handlerChoice(root) : {};
    const run = new RequestRun({ ran: this.ranOf(invocation) }, sources);
    const decisions = seenDecisions(tree, run, key);
    const places = placesOf(tree);
    const keyed = (node: TreeNode) => keyIn(key, node.id);
    const calls = this.callsOf(invocation, tree);
    const nodes = [...nodesOf(tree.nodes)];
    // A decision the frame took both ways (in a loop) reads as the last time it was taken.
    const lastly = new RequestRun({ ran: this.ranOf(invocation, true) }, sources);
    for (const node of nodes) {
      const place = places.get(node.id);
      if (!READ.has(node.kind) || place === undefined || decisions[keyed(node)] !== undefined) continue;
      const side = seenSide({ tree, place }, lastly);
      if (side !== undefined && side !== BOTH && side !== GOES) decisions[keyed(node)] = side;
    }
    // A decision the rules cannot tell (`??=`, a local function's) takes the one side whose calls of the map ran; else, where it ran, the one side that does not start with a call of the map that did not run.
    for (const node of nodes) {
      if (!SIDED.has(node.kind) || decisions[keyed(node)] !== undefined) continue;
      const sides = (node.branches ?? []).filter((branch) => branch.always !== true);
      const ran = sides.filter((branch) => [...nodesOf(branch.nodes)].some((inner) => callsFunction(inner) && calls.has(inner.id)));
      if (ran.length === 1 && ran[0] !== undefined) {
        decisions[keyed(node)] = ran[0].key;
        continue;
      }
      const place = places.get(node.id);
      const statement = place === undefined ? undefined : statementOf(tree, place);
      if (ran.length > 0 || statement === undefined || !nodeRan({ tree, place: statement }, run)) continue;
      const open = sides.filter((branch) => {
        const first = branch.nodes[0];
        return first === undefined || !callsFunction(first) || this.catalog.frame(first.target.id) === undefined;
      });
      if (open.length === 1 && open[0] !== undefined) decisions[keyed(node)] = open[0].key;
    }
    // A loop whose statement ran: a local function the tree puts on the lines of its call has its one side; a callback (`every`, `map`) the frame entered on its lines ran its body, one it did not was skipped (an operand short-circuited, a list empty).
    for (const node of nodes) {
      const place = places.get(node.id);
      const statement = place === undefined ? undefined : statementOf(tree, place);
      if (node.kind !== 'loop' || place === undefined || place.inlined || statement === undefined || decisions[keyed(node)] !== undefined || !nodeRan({ tree, place: statement }, run)) continue;
      const sides = (node.branches ?? []).filter((branch) => branch.always !== true);
      if (sides.length === 1 && sides[0] !== undefined) decisions[keyed(node)] = sides[0].key;
      else if (!/^(?:for|while|do)\b/.test(node.code) && sides.some((branch) => branch.key === 'skip')) {
        const entered = invocation.events.some((event) => {
          const probe = this.probeAt(event);
          return probe?.[1] === FUNCTION && probe[2] >= node.lines[0] && probe[2] <= node.lines[1];
        });
        decisions[keyed(node)] = entered ? 'body' : 'skip';
      }
    }
    for (const node of nodes) {
      if (!callsFunction(node)) continue;
      const child = calls.get(node.id);
      if (child === undefined) continue;
      if (this.threw(child.index, sources.treeOf)) decisions[keyed(node)] = FAILS;
      else if (decisions[keyed(node)] === FAILS) delete decisions[keyed(node)];
    }
    this.failCut(invocation, tree, key, decisions, sources.treeOf);
    // A call of the map in what a node evaluates first that did not run where that node ran: its operand was short-circuited.
    for (const node of nodes) {
      const place = places.get(node.id);
      if (!callsFunction(node) || place?.pre !== true || calls.has(node.id) || this.catalog.frame(node.target.id) === undefined) continue;
      const statement = statementOf(tree, place);
      if (statement !== undefined && nodeRan({ tree, place: statement }, run)) decisions[keyed(node)] = SKIPS;
    }
    return throughTries(tree, decisions, key);
  }

  /**
   * The statements an invocation left in the middle (cutAt), when no call of
   * the map it made from there threw: what it called outside the map threw,
   * so the last call of the statement to no function of the map fails
   * (FAILS), or the statement itself when it calls none. The walk then runs
   * up to there and on to the catch, not past it.
   */
  private failCut(invocation: Invocation, tree: FlowTree, key: string, decisions: Decisions, treeOf: (id: string) => FlowTree | undefined): void {
    const places = placesOf(tree);
    const lineOf = (event: number) => this.probeAt(event)?.[2] ?? 0;
    const own = invocation.events;
    for (const [at, event] of own.entries()) {
      const probe = this.probeAt(event);
      const holder = probe?.[1] === STATEMENT ? holderOf(tree, probe[2]) : undefined;
      if (holder === undefined) continue;
      // The last statement of its run of the holder, and the next own event past the holder.
      let past = at + 1;
      while (past < own.length && onLines(lineOf(own[past] ?? -1), [holder.node])) past += 1;
      if (own.slice(at + 1, past).some((later) => this.probeAt(later)?.[1] === STATEMENT)) continue;
      const next = own[past];
      const called = invocation.children.map((child) => this.invocations[child]).filter((child): child is Invocation => child !== undefined && child.start > event && (next === undefined || child.start < next));
      if (called.some((child) => this.threw(child.index, treeOf)) || (next === undefined && called.length > 0)) continue;
      const cut = this.cutAt(tree, event, next);
      if (cut === undefined) continue;
      // (A call of the map that ran has an invocation, which did not throw; one that has none did not run.)
      const free = (node: TreeNode) => node.kind === 'call' && !(callsFunction(node) && this.catalog.frame(node.target.id) !== undefined) && places.get(node.id)?.inlined !== true;
      const failing = cut.node.kind === 'call' && free(cut.node) ? cut.node : ([...evaluationOrder(cut.node.pre ?? [])].filter(free).pop() ?? (cut.node.kind === 'action' ? cut.node : undefined));
      if (failing !== undefined) decisions[keyIn(key, failing.id)] = FAILS;
    }
  }

  /** The side of the choice of handler of a root made from them (synthetic): the branch of the handler the request ran first. */
  private handlerChoice(root: FlowTree): Decisions {
    let first: { decision: string; side: string; start: number } | undefined;
    for (const node of nodesOf(root.nodes)) {
      for (const branch of node.branches ?? []) {
        for (const inner of nodesOf(branch.nodes)) {
          if (!callsFunction(inner)) continue;
          const ran = this.rootsOf(inner.target.id)[0];
          if (ran !== undefined && (first === undefined || ran.start < first.start)) first = { decision: node.id, side: branch.key, start: ran.start };
        }
      }
    }
    return first === undefined ? {} : { [first.decision]: first.side };
  }

  /** The decisions of the frames the trace has open (the root first), as one choice. */
  choice(root: FlowTree, frames: ReadonlyArray<{ key: string; tree: FlowTree }>, sources: RunSources): Decisions {
    let decisions: Decisions = {};
    for (const { key, tree } of frames) decisions = { ...decisions, ...(key === '' && root.synthetic === true ? this.handlerChoice(root) : this.decisionsOf(root, key, tree, sources)) };
    return decisions;
  }

  /** The keys of the frames of a root that the request ran, below the frames given: what the reader can open next. */
  ranBelow(root: FlowTree, frames: ReadonlyArray<{ key: string; tree: FlowTree }>, treeOf: (id: string) => FlowTree | undefined): string[] {
    const keys: string[] = [];
    for (const { key, tree } of frames) {
      for (const node of nodesOf(tree.nodes)) {
        if (!callsFunction(node)) continue;
        const child = keyIn(key, node.id);
        if (this.invocationAt(root, child, treeOf) !== undefined) keys.push(child);
      }
    }
    return keys;
  }

  /** The keys of every frame of a root the request ran whose tree is given, from the root down (ranBelow, each once): every frame a reader can open. */
  ranKeys(root: FlowTree, treeOf: (id: string) => FlowTree | undefined, depth = 32): string[] {
    const keys = new Set<string>();
    let frames: Array<{ key: string; tree: FlowTree }> = [{ key: '', tree: root }];
    for (let level = 0; level < depth && frames.length > 0; level += 1) {
      const next: Array<{ key: string; tree: FlowTree }> = [];
      for (const key of this.ranBelow(root, frames, treeOf)) {
        const tree = treeAtKey(root, key, treeOf);
        if (tree === undefined || keys.has(key)) continue;
        keys.add(key);
        next.push({ key, tree });
      }
      frames = next;
    }
    return [...keys];
  }
}

/** A place where a walk does not agree with what the request ran. */
export interface WalkMismatch {
  /** The key of the frame (`''` the root). */
  frame: string;
  node: string;
  code: string;
  /**
   * not-run: the walk passes a node the request did not run in that frame;
   * frame-not-run: the walk goes into a frame the request did not call;
   * did-not-fail: the walk has a call fail whose frame the request ran to its end;
   * skipped-but-ran: the walk does not pass a call of the map the request made in a frame it goes into;
   * wrong-side: the walk takes another side of a decision than the one the trace tells.
   */
  reason: 'not-run' | 'frame-not-run' | 'did-not-fail' | 'skipped-but-ran' | 'wrong-side';
}

/**
 * Where a walk of a root disagrees with the trace of the request it is
 * meant to replay: every node it passes in a frame the request ran must
 * have run there (when Istanbul counts it: a declaration runs nothing), a
 * frame it goes into must have been called, and a call it has fail must
 * have thrown; and the other way, in every frame it goes into, every call
 * of the map the request made must be one it passes, and every decision
 * whose side the trace tells must take that side. A walk on sides the rules
 * could not tell (assumed) is where these come from; none means the walk
 * shows a way the code took. `enabled` are the features the walk had on: a
 * call of one that is off is not looked for.
 */
export function walkMismatches(trace: RequestTrace, root: FlowTree, walk: Pick<FlowWalk, 'stops'> & Partial<Pick<FlowWalk, 'resolved' | 'cut'>>, sources: RunSources, options: { enabled?: ReadonlySet<string> } = {}): WalkMismatch[] {
  const mismatches: WalkMismatch[] = [];
  const runs = new Map<string, RequestRun | null>();
  const runOf = (frame: string): RequestRun | undefined => {
    let run = runs.get(frame);
    if (run === undefined) {
      const invocation = frame === '' && root.synthetic === true ? undefined : trace.invocationAt(root, frame, sources.treeOf);
      run = invocation === undefined ? null : new RequestRun({ ran: trace.ranOf(invocation) }, sources);
      runs.set(frame, run);
    }
    return run ?? undefined;
  };
  const treeOfStop = (id: string) => sources.treeOf(id) ?? (id === root.id ? root : undefined);
  for (const stop of walk.stops) {
    if (stop.frame === '' && root.synthetic === true) continue;
    const tree = treeOfStop(stop.tree);
    if (tree === undefined) continue;
    const run = runOf(stop.frame);
    if (run === undefined) {
      if (!mismatches.some((mismatch) => mismatch.frame === stop.frame && mismatch.reason === 'frame-not-run')) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'frame-not-run' });
      continue;
    }
    const place = placesOf(tree).get(stop.node.id);
    if (place === undefined || place.inlined) continue;
    if (callsFunction(stop.node) && sources.treeOf(stop.node.target.id) !== undefined) {
      // A call of a frame of the map ran when the request called that frame from here (its statement may start on another line).
      const child = trace.invocationAt(root, keyIn(stop.frame, stop.node.id), sources.treeOf);
      if (child === undefined) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'not-run' });
      else if (stop.event === 'fails' && !trace.threw(child.index, sources.treeOf)) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'did-not-fail' });
      continue;
    }
    // A call of anything else is read by the statement it is in, which may start above its lines.
    if (stop.node.kind === 'call' || !observable(stop.node) || stop.node.kind === 'try' || stop.node.kind === 'loop' || stop.node.kind === 'cond-expr' || stop.node.kind === 'switch') continue;
    if (!nodeRan({ tree, place }, run)) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'not-run' });
  }
  if (walk.cut === true) return mismatches;
  // The other way: what the request did in the frames the walk goes into.
  const entered = new Map<string, string>();
  for (const stop of walk.stops) if (!entered.has(stop.frame)) entered.set(stop.frame, stop.tree);
  const passed = new Set(walk.stops.map((stop) => keyIn(stop.frame, stop.node.id)));
  for (const [frame, id] of entered) {
    if (frame === '' && root.synthetic === true) continue;
    const tree = treeOfStop(id);
    const invocation = tree === undefined ? undefined : trace.invocationAt(root, frame, sources.treeOf);
    if (tree === undefined || invocation === undefined) continue;
    const places = placesOf(tree);
    for (const [node, child] of trace.callsOf(invocation, tree)) {
      const place = places.get(node);
      if (child === undefined || place === undefined || passed.has(keyIn(frame, node)) || featureOff(tree, place, options.enabled)) continue;
      mismatches.push({ frame, node, code: place.node.code, reason: 'skipped-but-ran' });
    }
    if (walk.resolved === undefined) continue;
    for (const [key, side] of Object.entries(trace.decisionsOf(root, frame, tree, sources))) {
      const node = frame === '' ? key : key.slice(frame.length + 1);
      const place = places.get(node);
      const taken = walk.resolved[key];
      if (place === undefined || !READ.has(place.node.kind) || taken === undefined || taken === side) continue;
      mismatches.push({ frame, node, code: place.node.code, reason: 'wrong-side' });
    }
  }
  return mismatches;
}

/** The tree of a frame key of a root: the trees its call nodes call, followed down; undefined where one is not loaded. */
export function treeAtKey(root: FlowTree, key: string, treeOf: (id: string) => FlowTree | undefined): FlowTree | undefined {
  if (key === '') return root;
  let tree: FlowTree | undefined = root;
  for (const id of key.split('.')) {
    const node: TreeNode | undefined = tree === undefined ? undefined : placesOf(tree).get(id)?.node;
    if (node?.kind !== 'call' || node.target?.kind !== 'function') return undefined;
    tree = treeOf(node.target.id);
    if (tree === undefined) return undefined;
  }
  return tree;
}

/** The function a frame key's last call node calls; undefined for the root or a key that names no such call. */
function calleeOf(root: FlowTree, key: string, treeOf: (id: string) => FlowTree | undefined): string | undefined {
  const at = key.lastIndexOf('.');
  const parent = treeAtKey(root, at < 0 ? '' : key.slice(0, at), treeOf);
  const node = parent === undefined ? undefined : placesOf(parent).get(key.slice(at + 1))?.node;
  return node?.target?.kind === 'function' ? node.target.id : undefined;
}

/** A request's trace followed through the frames of a root (followTrace). */
export interface FollowedTrace {
  /** Whether the request ran the root at all; when it did not, nothing else is said. */
  rootRan: boolean;
  /** The frames opened below the root, by key, in the order they were opened. */
  open: string[];
  /** The choice the walk took: the sides read from the trace. */
  decisions: Decisions;
  walk?: FlowWalk;
  /** The functions whose trees a frame to open needs and were not given: load them and follow again. */
  needs: string[];
  /** Where the walk disagrees with what the request ran (walkMismatches); none expected. */
  mismatches: WalkMismatch[];
}

/**
 * Follow a request's trace through a root the way the map replays it: the
 * frames given open, and for a root made from handlers, the handler the
 * request ran; the decisions of every open frame read from the trace; then
 * the frames of the calls the walk fails at opened one after another, down
 * to the throw that started the failure. A frame whose tree is not given is
 * named in `needs`, so a page that loads trees as it goes calls again once
 * it has them; the build gives every tree at once.
 */
export function followTrace(trace: RequestTrace, root: FlowTree, sources: RunSources, options: { open?: readonly string[]; enabled?: ReadonlySet<string> } = {}): FollowedTrace {
  if (!trace.rootRan(root)) return { rootRan: false, open: [], decisions: {}, needs: [], mismatches: [] };
  const open: string[] = [...(options.open ?? [])];
  if (root.synthetic === true) for (const key of trace.ranBelow(root, [{ key: '', tree: root }], sources.treeOf)) if (!open.includes(key)) open.push(key);
  const needs = new Set<string>();
  let decisions: Decisions = {};
  let walk: FlowWalk | undefined;
  for (let round = 0; round < 64; round += 1) {
    const frames = [{ key: '', tree: root }];
    for (const key of open) {
      const tree = treeAtKey(root, key, sources.treeOf);
      if (tree !== undefined) frames.push({ key, tree });
      else {
        const callee = calleeOf(root, key, sources.treeOf);
        if (callee !== undefined) needs.add(callee);
      }
    }
    decisions = trace.choice(root, frames, sources);
    const entered = new Map(frames.map(({ key, tree }) => [key, tree]));
    walk = walkFlow(root, decisions, { enter: (key) => entered.get(key), ...(options.enabled === undefined ? {} : { enabled: options.enabled }) });
    const failing: string[] = [];
    for (const stop of walk.stops) {
      if (stop.event !== 'fails' || stop.node.kind !== 'call' || stop.node.target?.kind !== 'function' || stop.node.target.id === stop.tree) continue;
      const key = keyIn(stop.frame, stop.node.id);
      if (open.includes(key) || failing.includes(key)) continue;
      if (sources.treeOf(stop.node.target.id) === undefined) needs.add(stop.node.target.id);
      else failing.push(key);
    }
    if (failing.length === 0) break;
    open.push(...failing);
  }
  return {
    rootRan: true,
    open,
    decisions,
    ...(walk === undefined ? {} : { walk }),
    needs: [...needs],
    mismatches: walk === undefined ? [] : walkMismatches(trace, root, walk, sources, options.enabled === undefined ? {} : { enabled: options.enabled }),
  };
}

/** Whether a key is a node or inside it (`s0b1` holds `s0b1s0`, not `s0b10`). */
function within(key: string, target: string): boolean {
  return key === target || (key.startsWith(target) && !/^\d/.test(key.slice(target.length)));
}

/**
 * The ready-made way a walk ended by. For a failure, the throw whose
 * failure reached the root: the last `throw` before the root's catch took
 * it (or before the walk failed out of the root); a throw a catch below
 * took is not one, unless that catch throws again (its own `throw` is then
 * the one). Its way is the failure way of that throw, else the failure way
 * of the same error from the same function (the map offers one way for
 * each error a function throws). Else the way of the end of the root it
 * reached (its return), or for an end no way names, the way into the
 * innermost step the end is in (a step that answers itself). Undefined for
 * none.
 */
export function endingSelection(selections: readonly Selection[], walk: Pick<FlowWalk, 'stops'> & Partial<Pick<FlowWalk, 'outcome'>>): Selection | undefined {
  let pending: FlowWalk['stops'][number] | undefined;
  let failed: FlowWalk['stops'][number] | undefined;
  for (const stop of walk.stops) {
    if (stop.event === 'throws') pending = stop;
    else if (stop.event === 'catches' && pending !== undefined) {
      if (stop.depth === 0) failed = pending;
      pending = undefined;
    }
  }
  if (walk.outcome === 'fails' && pending !== undefined) failed = pending;
  if (failed !== undefined) {
    const key = keyIn(failed.frame, failed.node.id);
    const failures = selections.filter((selection) => selection.kind === 'failure');
    return failures.find((selection) => selection.target === key)
      ?? failures.find((selection) => selection.failure?.from === failed?.tree && failed?.node.error !== undefined && selection.failure.error === failed.node.error);
  }
  const end = [...walk.stops].reverse().find((stop) => stop.depth === 0 && (stop.event === 'returns' || stop.event === 'ends'));
  if (end === undefined) return undefined;
  const exit = selections.find((selection) => selection.kind === 'exit' && selection.target === end.node.id);
  if (exit !== undefined) return exit;
  const steps = selections.filter((selection) => selection.kind === 'step' && !selection.target.includes('.') && within(end.node.id, selection.target));
  return steps.sort((a, b) => b.target.length - a.target.length)[0];
}

/**
 * The ready-made ways a walk took: the way it ended by (endingSelection),
 * and every way into a step whose node the walk went through on the sides
 * the way takes (each of its decisions is the side the walk resolved; a
 * `try` whose catch took a failure of its body ran both its sides). A way
 * of a change is not one a request takes.
 */
export function takenSelections(selections: readonly Selection[], walk: Pick<FlowWalk, 'stops' | 'resolved'> & Partial<Pick<FlowWalk, 'outcome'>>): Selection[] {
  const keys = walk.stops.map((stop) => keyIn(stop.frame, stop.node.id));
  const caught = new Set(walk.stops.filter((stop) => stop.event === 'catches').map((stop) => keyIn(stop.frame, stop.node.id)));
  const agrees = (selection: Selection) => Object.entries(selection.decisions).every(([key, side]) => walk.resolved[key] === side || (walk.resolved[key] === undefined && caught.has(key) && (side === 'try' || side === 'catch')));
  const ending = endingSelection(selections, walk);
  return selections.filter((selection) => selection === ending || (selection.kind === 'step' && keys.some((key) => within(key, selection.target)) && agrees(selection)));
}
