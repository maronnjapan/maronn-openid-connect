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
 * calls it (the catalog's `calls`), else the one that ran last. Each
 * invocation then has counters of its own, and the rules of observe.ts read
 * them as they read a whole request's, so a function called twice, or a
 * decision taken one way in one call and the other in another, reads apart.
 *
 * An invocation threw when what it ran last was a `throw` (the probe table
 * marks them; what the `throw` calls to make its error runs after it), or a
 * call that threw. A call of a frame whose invocation
 * threw fails, wherever it is in its list: the rules that look at the next
 * node cannot tell a call that ends its list.
 *
 * A frame of the map is named by its key, the call nodes from the root
 * down (`s0b1s0.s2`); the invocation of a key is the one its call node
 * made: of the invocations of that function its parent made, the one whose
 * call was on the node's lines, else the first.
 *
 * This module imports only types, observe.ts and walk.ts, so the page uses
 * it as it is: `@maronn-openid-connect/map-analysis/traced`.
 */
import type { Decisions, FlowTree, MapData, Selection, TreeNode } from './model.js';
import { nodeRan, observable, placesOf, RequestRun, seenDecisions, throughTries, type RanInFile, type RunSources } from './observe.js';
import { FAILS, nodesOf, walkFlow, type FlowWalk } from './walk.js';

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

/** A frame of the map as the reading places a probe in it. */
interface Frame {
  id: string;
  path: string;
  start: number;
  end: number;
  /** The line of its declaration, where its entry is counted. */
  line: number;
  calls: ReadonlySet<string>;
}

/** The frames of the map by the repository path of their file, to place a probe in the innermost one. */
export class FrameCatalog {
  private readonly byPath = new Map<string, Frame[]>();
  private readonly byId = new Map<string, Frame>();

  constructor(data: Pick<MapData, 'functions' | 'bodies' | 'sources'>) {
    for (const entry of [...Object.values(data.functions), ...Object.values(data.bodies)]) {
      if (entry.source === undefined) continue;
      const path = data.sources[entry.source.file]?.path;
      if (path === undefined) continue;
      const frame: Frame = { id: entry.id, path, start: entry.source.start, end: entry.source.end, line: entry.line, calls: new Set(entry.calls) };
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
  /** The indexes of the events of its own lines, in order. */
  events: number[];
  /** The line of its parent's last own event before it was called: the line of the call. */
  callLine?: number;
}

/** What a request ran, read into invocations (see the module comment). */
export class RequestTrace {
  readonly invocations: Invocation[] = [];
  private readonly threwMemo = new Map<number, boolean>();

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
    const latest = new Map<string, number>();
    /** The invocations in the order they last ran, the latest last. */
    const recent: number[] = [];
    const touch = (index: number): void => {
      const at = recent.lastIndexOf(index);
      if (at >= 0) recent.splice(at, 1);
      recent.push(index);
    };
    const lastLine = new Map<number, number>();
    run.events.forEach((probe, at) => {
      const frame = placeOf(probe);
      if (frame === undefined) return;
      const entry = table.probes[probe];
      if (entry === undefined) return;
      if (entry[1] === FUNCTION && entry[2] === frame.line) {
        // The latest invocation whose frame calls this one, else the one that ran last.
        let parent: number | undefined;
        for (let back = recent.length - 1; back >= 0; back -= 1) {
          const candidate = this.invocations[recent[back] ?? -1];
          if (candidate !== undefined && catalog.frame(candidate.frame)?.calls.has(frame.id)) {
            parent = candidate.index;
            break;
          }
        }
        parent ??= recent[recent.length - 1];
        const callLine = parent === undefined ? undefined : lastLine.get(parent);
        const invocation: Invocation = { index: this.invocations.length, frame: frame.id, ...(parent === undefined ? {} : { parent }), children: [], start: at, events: [], ...(callLine === undefined ? {} : { callLine }) };
        this.invocations.push(invocation);
        if (parent !== undefined) this.invocations[parent]?.children.push(invocation.index);
        latest.set(frame.id, invocation.index);
        touch(invocation.index);
        return;
      }
      let owner = latest.get(frame.id);
      if (owner === undefined) {
        // Lines of a frame whose entry was not seen: an invocation of its own, called from outside.
        owner = this.invocations.length;
        this.invocations.push({ index: owner, frame: frame.id, children: [], start: -1, events: [] });
        latest.set(frame.id, owner);
      }
      this.invocations[owner]?.events.push(at);
      lastLine.set(owner, entry[2]);
      touch(owner);
    });
  }

  /** The probe of an event. */
  private probeAt(event: number): TraceProbes['probes'][number] | undefined {
    return this.table.probes[this.run.events[event] ?? -1];
  }

  /**
   * Whether an invocation threw: what it ran last was a `throw`, or a call
   * that threw (its last child started after its own last event).
   */
  threw(index: number): boolean {
    const known = this.threwMemo.get(index);
    if (known !== undefined) return known;
    const invocation = this.invocations[index];
    let threw = false;
    if (invocation !== undefined) {
      const last = invocation.events[invocation.events.length - 1] ?? invocation.start;
      const probe = this.probeAt(last);
      // A `throw` counts before its expression runs (`throw invalidClient()` calls after it): it ends the invocation whatever it calls.
      if (probe !== undefined && probe[1] === STATEMENT && probe[4] === THROWS) threw = true;
      else {
        const lastChild = invocation.children.map((child) => this.invocations[child]).filter((child): child is Invocation => child !== undefined).sort((a, b) => b.start - a.start)[0];
        threw = lastChild !== undefined && lastChild.start > last && this.threw(lastChild.index);
      }
    }
    this.threwMemo.set(index, threw);
    return threw;
  }

  /** The invocations of a root's frame that were called from outside the frames of the map, in order: the endpoint body the router ran. */
  private rootsOf(rootId: string): Invocation[] {
    return this.invocations.filter((invocation) => invocation.frame === rootId);
  }

  /**
   * The invocation a frame key of a root names (`''` the root itself),
   * following the call nodes of the key through the trees; for a root made
   * from the endpoint's handlers (synthetic), its handlers are its calls.
   * Undefined when the request did not run it.
   */
  invocationAt(root: FlowTree, key: string, treeOf: (id: string) => FlowTree | undefined): Invocation | undefined {
    let tree = root;
    let invocation: Invocation | undefined = root.synthetic === true ? undefined : this.rootsOf(root.id)[0];
    if (key === '') return invocation;
    const ids = key.split('.');
    for (const [at, id] of ids.entries()) {
      const node = placesOf(tree).get(id)?.node;
      const target = node?.target;
      if (node === undefined || node.kind !== 'call' || target?.kind !== 'function') return undefined;
      const candidates = invocation === undefined
        ? (tree === root && root.synthetic === true ? this.rootsOf(target.id) : [])
        : invocation.children.map((child) => this.invocations[child]).filter((child): child is Invocation => child?.frame === target.id);
      invocation = candidates.find((candidate) => candidate.callLine !== undefined && candidate.callLine >= node.lines[0] && candidate.callLine <= node.lines[1]) ?? candidates[0];
      if (invocation === undefined) return undefined;
      if (at === ids.length - 1) break;
      const next = treeOf(target.id);
      if (next === undefined) return undefined;
      tree = next;
    }
    return invocation;
  }

  /** Whether the request ran the root at all (a request the router or the middleware answered did not). */
  rootRan(root: FlowTree): boolean {
    if (root.synthetic === true) return [...nodesOf(root.nodes)].some((node) => node.kind === 'call' && node.target?.kind === 'function' && this.rootsOf(node.target.id).length > 0);
    return this.rootsOf(root.id).length > 0;
  }

  /**
   * What an invocation ran, as the counters of a request (RanInFile by
   * repository path): its own statements and branch sides, and the entries
   * of the functions it called.
   */
  ranOf(invocation: Invocation): Record<string, RanInFile> {
    const files = new Map<string, { s: Map<string, [number, number, number]>; b: Map<string, [number, number, string, number[]]>; f: Map<number, [number, string] | [number]> }>();
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
        const side = probe[5] ?? 0;
        const sides = probe[6] ?? 0;
        const key = `${line}:${column}:${type}:${sides}`;
        const known = file.b.get(key) ?? [line, column, type, Array.from({ length: sides }, () => 0)];
        known[3][side] = (known[3][side] ?? 0) + 1;
        file.b.set(key, known);
      } else if (kind === FUNCTION) {
        file.f.set(line, entryOf(probe));
      }
    }
    for (const child of invocation.children) {
      const start = this.invocations[child]?.start ?? -1;
      const probe = start < 0 ? undefined : this.probeAt(start);
      const path = probe === undefined ? undefined : this.table.files[probe[0]];
      if (probe !== undefined && path !== undefined) fileOf(path).f.set(probe[2], entryOf(probe));
    }
    const ran: Record<string, RanInFile> = {};
    for (const [path, file] of files) {
      const byPlace = (a: readonly [number, number, ...unknown[]], b: readonly [number, number, ...unknown[]]) => a[0] - b[0] || a[1] - b[1];
      ran[path] = { s: [...file.s.values()].sort(byPlace), b: [...file.b.values()].sort(byPlace), f: [...file.f.values()].sort((a, b) => a[0] - b[0]) };
    }
    return ran;
  }

  /**
   * The sides a frame took in the invocation its key names: the decisions
   * the rules of observe.ts read from the invocation's own counters, its
   * calls of frames that threw failing and the others going on, through the
   * tries whose body has a call that failed (throughTries). None for a frame
   * the request did not run.
   */
  decisionsOf(root: FlowTree, key: string, tree: FlowTree, sources: RunSources): Decisions {
    const invocation = this.invocationAt(root, key, sources.treeOf);
    if (invocation === undefined) return root.synthetic === true && key === '' ? this.handlerChoice(root) : {};
    const run = new RequestRun({ ran: this.ranOf(invocation) }, sources);
    const decisions = seenDecisions(tree, run, key);
    const keyed = (node: TreeNode) => (key === '' ? node.id : `${key}.${node.id}`);
    for (const node of nodesOf(tree.nodes)) {
      if (node.kind !== 'call' || node.target?.kind !== 'function') continue;
      const child = this.invocationAt(root, keyed(node), sources.treeOf);
      if (child === undefined) continue;
      if (this.threw(child.index)) decisions[keyed(node)] = FAILS;
      else if (decisions[keyed(node)] === FAILS) delete decisions[keyed(node)];
    }
    return throughTries(tree, decisions, key);
  }

  /** The side of the choice of handler of a root made from them (synthetic): the branch of the handler the request ran first. */
  private handlerChoice(root: FlowTree): Decisions {
    let first: { decision: string; side: string; start: number } | undefined;
    for (const node of nodesOf(root.nodes)) {
      for (const branch of node.branches ?? []) {
        for (const inner of nodesOf(branch.nodes)) {
          if (inner.kind !== 'call' || inner.target?.kind !== 'function') continue;
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
        if (node.kind !== 'call' || node.target?.kind !== 'function') continue;
        const child = key === '' ? node.id : `${key}.${node.id}`;
        if (this.invocationAt(root, child, treeOf) !== undefined) keys.push(child);
      }
    }
    return keys;
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
   * did-not-fail: the walk has a call fail whose frame the request ran to its end.
   */
  reason: 'not-run' | 'frame-not-run' | 'did-not-fail';
}

/**
 * Where a walk of a root disagrees with the trace of the request it is
 * meant to replay: every node it passes in a frame the request ran must
 * have run there (when Istanbul counts it: a declaration runs nothing), a
 * frame it goes into must have been called, and a call it has fail must
 * have thrown. A walk on sides the rules could not tell (assumed) is where
 * these come from; none means the walk shows a way the code took.
 */
export function walkMismatches(trace: RequestTrace, root: FlowTree, walk: Pick<FlowWalk, 'stops'>, sources: RunSources): WalkMismatch[] {
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
  for (const stop of walk.stops) {
    if (stop.frame === '' && root.synthetic === true) continue;
    const tree = sources.treeOf(stop.tree) ?? (stop.tree === root.id ? root : undefined);
    if (tree === undefined) continue;
    const run = runOf(stop.frame);
    if (run === undefined) {
      if (!mismatches.some((mismatch) => mismatch.frame === stop.frame && mismatch.reason === 'frame-not-run')) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'frame-not-run' });
      continue;
    }
    const place = placesOf(tree).get(stop.node.id);
    if (place === undefined || place.inlined) continue;
    if (stop.node.kind === 'call' && stop.node.target?.kind === 'function' && sources.treeOf(stop.node.target.id) !== undefined) {
      // A call of a frame of the map ran when the request called that frame from here (its statement may start on another line).
      const child = trace.invocationAt(root, stop.frame === '' ? stop.node.id : `${stop.frame}.${stop.node.id}`, sources.treeOf);
      if (child === undefined) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'not-run' });
      else if (stop.event === 'fails' && !trace.threw(child.index)) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'did-not-fail' });
      continue;
    }
    // A call of anything else is read by the statement it is in, which may start above its lines.
    if (stop.node.kind === 'call' || !observable(stop.node) || stop.node.kind === 'try' || stop.node.kind === 'loop' || stop.node.kind === 'cond-expr' || stop.node.kind === 'switch') continue;
    if (!nodeRan({ tree, place }, run)) mismatches.push({ frame: stop.frame, node: stop.node.id, code: stop.node.code, reason: 'not-run' });
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
      const key = stop.frame === '' ? stop.node.id : `${stop.frame}.${stop.node.id}`;
      if (open.includes(key) || failing.includes(key)) continue;
      if (sources.treeOf(stop.node.target.id) === undefined) needs.add(stop.node.target.id);
      else failing.push(key);
    }
    if (failing.length === 0) break;
    open.push(...failing);
  }
  return { rootRan: true, open, decisions, ...(walk === undefined ? {} : { walk }), needs: [...needs], mismatches: walk === undefined ? [] : walkMismatches(trace, root, walk, sources) };
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
    const key = failed.frame === '' ? failed.node.id : `${failed.frame}.${failed.node.id}`;
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
 * and every way into a step whose node the walk went through. A way of a
 * change is not one a request takes.
 */
export function takenSelections(selections: readonly Selection[], walk: Pick<FlowWalk, 'stops'> & Partial<Pick<FlowWalk, 'outcome'>>): Selection[] {
  const keys = walk.stops.map((stop) => (stop.frame === '' ? stop.node.id : `${stop.frame}.${stop.node.id}`));
  const ending = endingSelection(selections, walk);
  return selections.filter((selection) => selection === ending || (selection.kind === 'step' && keys.some((key) => within(key, selection.target))));
}
