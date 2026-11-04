/**
 * A trace: the frames of one way through the code, from an endpoint (or a
 * function) down through the calls the reader opens, and the sides of the
 * decisions they chose. Nothing here touches the DOM.
 *
 * - A frame is the tree of a function or of an endpoint body. The root is
 *   frame `''`; a call node opens the frame of its callee, keyed by the
 *   chain of call nodes that leads to it (`s0b1s0`, `s0b1s0.s2`).
 * - A choice maps decisions (keyed `<frame>.<node>`, the root's by the node
 *   alone) to a side. Several choices are their union; no choice shows
 *   everything.
 * - A feature that is off takes its blocks out of the tree, and a decision
 *   that reads a value of such a block keeps only the side where the value
 *   is missing.
 */
import type { Branch, Decisions, FlowTree, FrameChange, MapData, MemberDoc, RemovedNode, TreeNode } from '../types';
import { splitPre } from './words';

/** The state of a trace that the hash keeps. */
export interface TraceState {
  /** The frames opened, by key. */
  open: string[];
  /** The choices: each decision key → side; several are their union, none shows everything. */
  choices: Decisions[];
  /** Show where the failure of each call is caught. */
  errors: boolean;
  /** The frame the diagram shows. */
  focus: string;
}

export const EMPTY_TRACE: TraceState = { open: [], choices: [], errors: false, focus: '' };

/** The decision key of a node of a frame. */
export function decisionKey(frame: string, node: string): string {
  return frame === '' ? node : `${frame}.${node}`;
}

/** The key of the frame a call node of a frame opens. */
export function childFrame(frame: string, node: string): string {
  return frame === '' ? node : `${frame}.${node}`;
}

/** Whether a frame (by its key) is the frame of `key` or one opened below it: `s2b6s0.s1` is below `s2b6s0`, while `s2b6s0i0`, the frame of another call, is not; every frame is below the root. */
export function withinFrame(candidate: string, key: string): boolean {
  return key === '' || candidate === key || candidate.startsWith(`${key}.`);
}

/** The frame a key's frame was opened from, and the call node that opened it; undefined for the root. */
export function parentOf(key: string): { frame: string; node: string } | undefined {
  if (key === '') return undefined;
  const dot = key.lastIndexOf('.');
  return dot === -1 ? { frame: '', node: key } : { frame: key.slice(0, dot), node: key.slice(dot + 1) };
}

/** What a frame id names in the index: a function of the catalog or an endpoint body. */
export function entryOf(data: Pick<MapData, 'functions' | 'bodies'>, id: string): MapData['functions'][string] | MapData['bodies'][string] | undefined {
  return data.functions[id] ?? data.bodies[id];
}

/** The frame id each opened key is, following the call nodes of the trees loaded so far. */
export function frameIds(rootId: string, open: readonly string[], trees: ReadonlyMap<string, FlowTree>): Map<string, string> {
  const ids = new Map<string, string>([['', rootId]]);
  const sorted = [...open].sort((a, b) => a.split('.').length - b.split('.').length);
  for (const key of sorted) {
    const parent = parentOf(key);
    if (parent === undefined) continue;
    const parentId = ids.get(parent.frame);
    const tree = parentId === undefined ? undefined : trees.get(parentId);
    const node = tree === undefined ? undefined : findNode(tree.nodes, parent.node);
    if (node?.target?.kind === 'function') ids.set(key, node.target.id);
  }
  return ids;
}

/** The node of a list (and below) with an id. */
export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (!id.startsWith(node.id)) continue;
    const found = findNode(node.pre ?? [], id) ?? (node.branches ?? []).reduce<TreeNode | undefined>((hit, branch) => hit ?? findNode(branch.nodes, id), undefined);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---- features

/** Whether a feature named by a node (its marker id, `refresh-token`) is on: `enabled` holds the ids of the features that are. */
export function featureOn(enabled: ReadonlySet<string> | undefined, feature: string | undefined): boolean {
  return feature === undefined || enabled === undefined || enabled.has(feature);
}

/** The side a decision must take with the features that are on, or undefined. */
export function forcedSide(node: TreeNode, enabled: ReadonlySet<string> | undefined): string | undefined {
  return node.absent !== undefined && !featureOn(enabled, node.absent.feature) ? node.absent.side : undefined;
}

/** The branches of a decision that remain with the features that are on. */
export function branchesOf(node: TreeNode, enabled: ReadonlySet<string> | undefined): Branch[] {
  const forced = forcedSide(node, enabled);
  return (node.branches ?? []).filter((branch) => forced === undefined || branch.key === forced || branch.always === true);
}

/** The nodes of a list that remain with the features that are on. */
export function nodesOn(nodes: readonly TreeNode[], enabled: ReadonlySet<string> | undefined): TreeNode[] {
  return nodes.filter((node) => featureOn(enabled, node.feature));
}

// ---- which nodes a choice runs

const DECISIONS = new Set(['if', 'switch', 'cond-expr', 'loop', 'try']);

/**
 * The side a choice gives a call node to say that the call throws there (a
 * way to a failure): the rest of its list does not run, and the failure goes
 * up to the innermost `try` with a `catch` around it in the frame, whose
 * catch runs; with no such `try`, the frame ends there.
 */
export const FAILS = 'fails';

/** Whether a node is a decision a reader can choose a side of. */
export function isDecision(node: TreeNode): boolean {
  return DECISIONS.has(node.kind) && (node.branches ?? []).filter((branch) => branch.always !== true).length > 1;
}

/** What running a list comes to: whether it goes on past its end, and whether a failure may leave it (a throw, or a call the choice makes fail). */
interface Outcome {
  goes: boolean;
  fails: boolean;
}

/** Mark the nodes of a list a choice runs (see Outcome for what it returns). */
function run(nodes: readonly TreeNode[], frame: string, choice: Decisions, enabled: ReadonlySet<string> | undefined, running: boolean, on: Set<string>): Outcome {
  let going = running;
  let fails = false;
  for (const node of nodesOn(nodes, enabled)) {
    if (!going) continue;
    on.add(node.id);
    if (node.pre !== undefined) {
      const before = run(node.pre, frame, choice, enabled, true, on);
      fails ||= before.fails;
      // A call evaluated before the node failed: the node does not go on.
      if (!before.goes) {
        going = false;
        continue;
      }
    }
    if (node.kind === 'call' && choice[decisionKey(frame, node.id)] === FAILS) {
      fails = true;
      going = false;
      continue;
    }
    switch (node.kind) {
      case 'return':
        if (node.local !== true) going = false;
        break;
      case 'throw':
        fails = true;
        going = false;
        break;
      case 'block': {
        const inner = run(node.branches?.[0]?.nodes ?? [], frame, choice, enabled, true, on);
        fails ||= inner.fails;
        going = inner.goes;
        break;
      }
      case 'try': {
        const outcome = attempt(node, frame, choice, enabled, on);
        fails ||= outcome.fails;
        going = outcome.goes;
        break;
      }
      default: {
        if (node.branches === undefined) break;
        const forced = forcedSide(node, enabled);
        const chosen = forced ?? choice[decisionKey(frame, node.id)];
        let anyGoes = false;
        let finallyGoes = true;
        let bodyEnds = false;
        for (const branch of branchesOf(node, enabled)) {
          if (branch.always === true) {
            const final = run(branch.nodes, frame, choice, enabled, true, on);
            finallyGoes = final.goes;
            fails ||= final.fails;
            continue;
          }
          const taken = chosen === undefined || branch.key === chosen;
          const side = run(branch.nodes, frame, choice, enabled, taken, on);
          if (taken && side.goes) anyGoes = true;
          if (taken) fails ||= side.fails;
          if (taken && branch.key === 'body' && !side.goes && side.fails) bodyEnds = true;
        }
        // A loop may run no time, unless its body fails on the way chosen; a switch with no side chosen may match no case.
        if (node.kind === 'loop' && !bodyEnds) anyGoes = true;
        if (node.kind === 'switch' && chosen === undefined) anyGoes = true;
        going = anyGoes && finallyGoes;
      }
    }
  }
  return { goes: going, fails };
}

/**
 * A `try`: its body, its catch (when the choice takes it or none, or when
 * the body fails whatever its decisions choose), then its finally. A failure
 * in the body goes no further than a catch; one without a catch, or one the
 * catch throws again, leaves it.
 */
function attempt(node: TreeNode, frame: string, choice: Decisions, enabled: ReadonlySet<string> | undefined, on: Set<string>): Outcome {
  const branches = branchesOf(node, enabled);
  const chosen = forcedSide(node, enabled) ?? choice[decisionKey(frame, node.id)];
  const body = branches.find((branch) => branch.key === 'try');
  const handler = branches.find((branch) => branch.key === 'catch');
  const final = branches.find((branch) => branch.always === true);
  const tried = run(body?.nodes ?? [], frame, choice, enabled, body !== undefined && (chosen === undefined || chosen === 'try'), on);
  const catches = handler !== undefined && (chosen === undefined || chosen === 'catch' || (tried.fails && !tried.goes));
  const caught = handler === undefined ? { goes: false, fails: false } : run(handler.nodes, frame, choice, enabled, catches, on);
  const finished = final === undefined ? { goes: true, fails: false } : run(final.nodes, frame, choice, enabled, true, on);
  return {
    goes: (tried.goes || (catches && caught.goes)) && finished.goes,
    fails: (handler === undefined ? tried.fails : catches && caught.fails) || finished.fails,
  };
}

/** The nodes of a frame the choices run (their union), by id; every node when there is no choice. */
export function nodesRun(tree: FlowTree, frame: string, choices: readonly Decisions[], enabled: ReadonlySet<string> | undefined): Set<string> {
  const on = new Set<string>();
  const list = choices.length === 0 ? [{}] : choices;
  for (const choice of list) run(tree.nodes, frame, choice, enabled, true, on);
  return on;
}

/** The side all the choices take at a decision; undefined when they take none or several. */
export function chosenSide(choices: readonly Decisions[], key: string): string | undefined {
  if (choices.length === 0) return undefined;
  const sides = new Set(choices.map((choice) => choice[key]));
  if (sides.size !== 1) return undefined;
  return [...sides][0];
}

/** The choices with one decision set to a side in each (a new choice when there is none), or cleared from each. */
export function choose(choices: readonly Decisions[], key: string, side: string | undefined): Decisions[] {
  const list = choices.length === 0 ? [{}] : choices;
  const next = list.map((choice) => {
    const copy = { ...choice };
    if (side === undefined) delete copy[key];
    else copy[key] = side;
    return copy;
  });
  return next.every((choice) => Object.keys(choice).length === 0) ? [] : next;
}

// ---- the way to a node

/** The sides that let a list run on past a node that could end it there. */
function pass(node: TreeNode, decisions: Decisions, frame: string): void {
  if (node.kind === 'block') {
    for (const child of node.branches?.[0]?.nodes ?? []) pass(child, decisions, frame);
    return;
  }
  if (!DECISIONS.has(node.kind) || node.kind === 'loop') return;
  const branches = (node.branches ?? []).filter((branch) => branch.always !== true);
  const going = branches.filter((branch) => !ends(branch.nodes));
  if (going.length === branches.length || going.length !== 1) return;
  const only = going[0] as Branch;
  decisions[decisionKey(frame, node.id)] = only.key;
  for (const child of only.nodes) pass(child, decisions, frame);
}

/** Whether a list ends its frame whatever the decisions in it choose. */
export function ends(nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => {
    if (node.kind === 'throw' || (node.kind === 'return' && node.local !== true)) return true;
    if (node.kind === 'block') return ends(node.branches?.[0]?.nodes ?? []);
    if (node.kind === 'if') return (node.branches ?? []).length === 2 && (node.branches ?? []).every((branch) => ends(branch.nodes));
    return false;
  });
}

/** The decisions (with the frame's keys) that lead to a node of a frame: the sides it is inside of, and the sides that pass what is before it. */
export function wayTo(tree: FlowTree, frame: string, id: string): Decisions | undefined {
  const decisions: Decisions = {};
  const search = (list: readonly TreeNode[]): boolean => {
    for (const node of list) {
      if (node.id === id) return true;
      if (id.startsWith(node.id) && findNode([node], id) !== undefined) {
        if (node.pre !== undefined && findNode(node.pre, id) !== undefined) return search(node.pre);
        for (const branch of node.branches ?? []) {
          if (findNode(branch.nodes, id) === undefined) continue;
          if (DECISIONS.has(node.kind) && branch.always !== true) decisions[decisionKey(frame, node.id)] = branch.key;
          return search(branch.nodes);
        }
        return false;
      }
      pass(node, decisions, frame);
    }
    return false;
  };
  return search(tree.nodes) ? decisions : undefined;
}

// ---- changes below

/** The source the endpoints of a framework are generated from: `nextjs`, or `hono` (Hono, Express and Fastify). */
export function sourceOf(framework: string): string {
  return framework === 'nextjs' ? 'nextjs' : 'hono';
}

/** Whether the code of an id runs for a source: an app root (`hono:`, `nextjs:`) only for its own, a package root (`core:`, `experimental:`, `google-login:`) and anything else for every source; every source runs it when none is given. */
export function runsFor(id: string, source: string | undefined): boolean {
  if (source === undefined) return true;
  const root = id.slice(0, Math.max(0, id.indexOf(':')));
  return (root !== 'hono' && root !== 'nextjs') || root === source;
}

/** The changes of a map by frame id, and what each frame (or member of an interface) reaches below it. */
export interface ChangeReach {
  /** The changed frames (their code) by id, with how many changes of each kind. */
  changed: ReadonlyMap<string, Record<string, number>>;
  /**
   * The changed frames a frame or a member leads to (itself left out), by
   * id: through the calls of a frame; for a member, through its changed
   * implementations and what its implementations call, the source's own.
   */
  below(id: string): ReadonlySet<string>;
  /**
   * The part of each changed frame below a frame or a member (see below)
   * that matters there: the members whose implementations in it the way
   * goes through (only the changes inside their lines lead there), or
   * undefined when the frame is reached by a call of it, whole.
   */
  parts(id: string): ReadonlyMap<string, ReadonlySet<string> | undefined>;
  /** The changed frames that implement a member, the source's own. */
  implementers(member: string): readonly string[];
}

/**
 * What reaches the changes of a map (see ChangeReach), for the endpoints of
 * a source (`hono` or `nextjs`, see sourceOf): an implementation in an app
 * root counts only for its own source. Undefined for a map without changes.
 */
export function changeReach(data: MapData, source?: string): ChangeReach | undefined {
  const changes = data.changes;
  if (changes === undefined) return undefined;
  const changed = new Map<string, Record<string, number>>();
  for (const entry of changes.frames) {
    if (entry.kind === 'added' || entry.kind === 'modified') changed.set(entry.id, entry.counts);
  }
  // A changed implementation of a member counts at every call of the member.
  const members = new Map<string, string[]>();
  for (const entry of changes.frames) {
    if (!changed.has(entry.id) || !runsFor(entry.id, source)) continue;
    for (const member of entry.members ?? []) members.set(member, [...(members.get(member) ?? []), entry.id]);
  }
  const memo = new Map<string, Map<string, Set<string> | undefined>>();
  const partsOf = (id: string): Map<string, Set<string> | undefined> => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const found = new Map<string, Set<string> | undefined>();
    memo.set(id, found);
    /** A frame reached whole (no members) or through the implementations of some members: whole wins. */
    const add = (frame: string, part: ReadonlySet<string> | undefined) => {
      if (frame === id) return;
      if (found.has(frame) && found.get(frame) === undefined) return;
      found.set(frame, part === undefined ? undefined : new Set([...(found.get(frame) ?? []), ...part]));
    };
    // A member is no frame: its changed implementations, then what its implementations call (a map without members, none).
    const member: MemberDoc | undefined = data.members?.[id];
    for (const implementer of members.get(id) ?? []) add(implementer, new Set([id]));
    const callees = member === undefined ? (entryOf(data, id)?.sites ?? []).map(([, callee]) => callee) : (member.calls ?? []);
    for (const callee of callees) {
      if (!runsFor(callee, source)) continue;
      if (changed.has(callee)) add(callee, undefined);
      for (const [deeper, part] of partsOf(callee)) add(deeper, part);
    }
    return found;
  };
  const keys = new Map<string, ReadonlySet<string>>();
  const below = (id: string): ReadonlySet<string> => {
    const known = keys.get(id);
    if (known !== undefined) return known;
    const found = new Set(partsOf(id).keys());
    keys.set(id, found);
    return found;
  };
  return { changed, below, parts: partsOf, implementers: (member) => members.get(member) ?? [] };
}

/** The frames to open from a frame so that every change below it shows: every call node whose callee leads to one, down to the changes, each frame once on a way. */
export function framesToChanges(data: MapData, reach: ChangeReach, rootId: string, rootKey = ''): string[] {
  const opened: string[] = [];
  const visit = (id: string, key: string, chain: readonly string[]) => {
    const entry = entryOf(data, id);
    for (const [node, callee] of entry?.sites ?? []) {
      if (!(reach.changed.has(callee) || reach.below(callee).size > 0) || chain.includes(callee) || entryOf(data, callee) === undefined) continue;
      const child = childFrame(key, node);
      opened.push(child);
      visit(callee, child, [...chain, callee]);
    }
  };
  visit(rootId, rootKey, [rootId]);
  return opened;
}

// ---- the rows of the outline

/** What a row of the outline shows of its frame: the nodes (their marks, hunks and expression changes go on it), and what the calls among them reach (functions and members, by id). */
export interface Held {
  holds: string[];
  calls: string[];
}

/** A row of the outline: a node of a tree (a statement, a decision, a step), a side of a decision, a run of statements, the start of the root frame when the pull request changed its declaration, a node the pull request removed, or a frame still loading. */
export type Row =
  | ({
      kind: 'node';
      key: string;
      frame: string;
      node: TreeNode;
      depth: number;
      on: boolean;
      /** A call the row stands for besides its node: the call evaluated last before a condition or a return (`if (!isX(y))`), or the one call of a step. Its frame opens below the row. */
      call?: TreeNode;
      /** The state of the frame the row opens: of the node when it is a call, else of `call`. */
      frameState?: 'open' | 'closed' | 'recursion' | 'loading';
      /** A guard or an optional item read on one line: what its true side does, and whether the choices run it. */
      exit?: { nodes: TreeNode[]; on: boolean };
      /** A step: whether its body shows below it, and how a folded one ends the flow (its returns and throws, each with whether the choices run it). A step of one call is `merged` with it, and opens the call's frame instead. */
      step?: { open: boolean; merged: boolean; exits: Array<{ node: TreeNode; on: boolean }> };
      /** A call evaluated before the statement of the next row (an argument of another call). */
      before: boolean;
      /** The choices make the call of the row fail here (FAILS). */
      fails?: boolean;
    } & Held)
  | ({
      kind: 'branch';
      key: string;
      frame: string;
      node: TreeNode;
      branch: Branch;
      depth: number;
      on: boolean;
      /** The choices take this side, and only this one. */
      chosen: boolean;
      /** A side that ends at once (a catch that answers with an error) or does nothing, read on its own row. */
      exit?: { nodes: TreeNode[]; on: boolean };
      /** The step such a side holds folded, by node id: opening it (its row key `<frame>|<id>`) shows the side's rows, as in the diagram. */
      step?: string;
    } & Held)
  | ({
      kind: 'run';
      key: string;
      frame: string;
      /** Statements in a row that say nothing in words (variables, settings), read as one line until the reader opens them. */
      nodes: TreeNode[];
      depth: number;
      on: boolean;
      open: boolean;
    } & Held)
  | ({ kind: 'start'; key: string; frame: string; depth: number } & Held)
  | { kind: 'removed'; key: string; frame: string; node: TreeNode; depth: number }
  | { kind: 'loading'; key: string; frame: string; depth: number };

/** What the rows of the outline of a trace are made from (see traceRows). */
export interface RowOptions {
  rootId: string;
  /** Whether a function has a frame the page can open (a file of its tree). */
  hasFrame(id: string): boolean;
  /** The trees loaded, by frame id. */
  trees: ReadonlyMap<string, FlowTree>;
  /** The diff of each changed frame, by frame id. */
  changes?: ReadonlyMap<string, FrameChange>;
  state: TraceState;
  enabled?: ReadonlySet<string>;
  /** The steps the reader opened or folded, by row key (`<frame>|<node>`, the key the diagram reads too): each flips its step's default (see stepHolds). A run of statements (see foldCode) the reader opened is in it too. */
  toggled?: ReadonlySet<string>;
  /** Read two or more statements in a row that say nothing in words (variables, settings) as one line (a 'run' row), as an outline of words does. */
  foldCode?: boolean;
}

/** Whether a statement says nothing in words: an action with no comment above it, whose code is all the outline could show. */
function silent(node: TreeNode): boolean {
  return node.kind === 'action' && node.branches === undefined && (node.pre ?? []).length === 0 && !(node.text !== undefined && (node.from === 'comment' || node.from === 'doc'));
}

/** Whether a key or an id is below another: it starts with it and goes on with a new segment (`s0b2s0` below `s0b2`, not `s0b21`). */
function below(candidate: string, prefix: string): boolean {
  return candidate.startsWith(prefix) && /^[a-z.]/.test(candidate.slice(prefix.length));
}

/** Whether a side ends at once: a few nodes, no decision among them, and the last returns or throws. */
function endsAtOnce(nodes: readonly TreeNode[]): boolean {
  return nodes.length > 0 && nodes.length <= 3 && ends(nodes) && !nodes.some((node) => isDecision(node) || (node.pre ?? []).some((evaluated) => evaluated.branches !== undefined));
}

/** Every node of a list that is on and every node below it that is on: its calls evaluated before, the sides of its decisions. */
export function nodesBelow(nodes: readonly TreeNode[], enabled: ReadonlySet<string> | undefined): TreeNode[] {
  return nodesOn(nodes, enabled).flatMap((node) => [node, ...nodesBelow(node.pre ?? [], enabled), ...branchesOf(node, enabled).flatMap((branch) => nodesBelow(branch.nodes, enabled))]);
}

/** What some nodes of a frame show (see Held): their ids, and the functions and members their calls reach. */
export function heldBy(nodes: readonly TreeNode[]): Held {
  return { holds: nodes.map((node) => node.id), calls: [...new Set(nodes.flatMap((node) => (node.kind === 'call' && (node.target?.kind === 'function' || node.target?.kind === 'member') ? [node.target.id] : [])))] };
}

/** The ids of the nodes of a frame its diff names: those added or modified (the start, '', among them) and those a removed node stood under. */
export function changedIdsOf(change: FrameChange | undefined): string[] {
  return [...Object.keys(change?.marks ?? {}), ...(change?.removed ?? []).map((removed) => removed.parent ?? '')];
}

/**
 * The call a step stands for: a step whose body, with the features that are
 * on, is exactly one call (no argument that is a call of its own) of a
 * function with a frame. Its row (and its box) is that call's, and opens the
 * call's frame; undefined for any other step.
 */
export function stepCall(node: TreeNode, enabled: ReadonlySet<string> | undefined, hasFrame: (id: string) => boolean): TreeNode | undefined {
  if (node.kind !== 'block') return undefined;
  const body = nodesOn(node.branches?.[0]?.nodes ?? [], enabled);
  const only = body.length === 1 ? body[0] : undefined;
  if (only === undefined || only.kind !== 'call' || only.branches !== undefined || nodesOn(only.pre ?? [], enabled).length > 0) return undefined;
  return only.target?.kind === 'function' && hasFrame(only.target.id) ? only : undefined;
}

/**
 * Whether a step of a frame holds what opens it without being asked: a node
 * the pull request changed (`changedIds`, see changedIdsOf), a frame opened
 * below one of its calls, or a decision the choices choose a side of (a
 * call they make fail among them). A step that holds none of these is
 * folded; the reader's toggle flips either.
 */
export function stepHolds(frameKey: string, node: TreeNode, state: Pick<TraceState, 'open' | 'choices'>, changedIds: readonly string[]): boolean {
  const key = decisionKey(frameKey, node.id);
  return changedIds.some((changed) => below(changed, node.id)) || state.open.some((open) => below(open, key)) || state.choices.some((choice) => Object.keys(choice).some((chosen) => below(chosen, key)));
}

/**
 * Whether a guard or an optional item (`if` of form guard or optional) reads
 * as one line: neither it nor anything below it changed (`changed`), and its
 * true side, the calls evaluated in it included, holds no call of a function
 * with a frame (which the reader must be able to open) and no decision
 * (whose sides the reader must be able to choose).
 */
export function foldsGuard(node: TreeNode, enabled: ReadonlySet<string> | undefined, hasFrame: (id: string) => boolean, changed: (id: string) => boolean): boolean {
  if (node.kind !== 'if' || (node.form !== 'guard' && node.form !== 'optional')) return false;
  if (changed(node.id) || everyNode(node.pre ?? []).some((child) => changed(child.id)) || (node.branches ?? []).some((branch) => everyNode(branch.nodes).some((child) => changed(child.id)))) return false;
  const yes = branchesOf(node, enabled).find((branch) => branch.key === 'true');
  return !nodesBelow(yes?.nodes ?? [], enabled).some((child) => isDecision(child) || (child.kind === 'call' && child.target?.kind === 'function' && hasFrame(child.target.id)));
}

/** Every node of a list and below it, the features ignored. */
function everyNode(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.pre ?? []), ...(node.branches ?? []).flatMap((branch) => everyNode(branch.nodes))]);
}

/** The returns and throws that end a frame among some nodes: how a folded step ends the flow. */
function exitsOf(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.filter((node) => node.kind === 'throw' || (node.kind === 'return' && node.local !== true));
}

/**
 * The rows of the outline of a trace (see Row): each frame's tree indented
 * below the call that opened it. Every side of a decision keeps its rows; the
 * choices only turn the rows they do not run off, so nothing goes away. A
 * step folds to its label until the reader opens it (or it holds what
 * opens it, see stepHolds); a step of one call is that call's row (see
 * stepCall). A guard or an optional item reads on one line (see foldsGuard),
 * a `try` heads the rows it guards and its catch follows them, and the call
 * evaluated last before a condition or a return shares that row.
 */
export function traceRows(options: RowOptions): Row[] {
  const { trees, state, enabled } = options;
  const toggled = options.toggled ?? new Set<string>();
  const ids = frameIds(options.rootId, state.open, trees);
  const opened = new Set(state.open);
  const rows: Row[] = [];
  const frame = (key: string, id: string, depth: number, chain: readonly string[]) => {
    const tree = trees.get(id);
    if (tree === undefined) {
      rows.push({ kind: 'loading', key: `${key}|loading`, frame: key, depth });
      return;
    }
    const on = nodesRun(tree, key, state.choices, enabled);
    const change = options.changes?.get(id);
    const removedAfter = new Map<string, RemovedNode[]>();
    for (const removed of change?.removed ?? []) {
      const at = removed.after ?? `${removed.parent}|${removed.branch ?? ''}|start`;
      removedAfter.set(at, [...(removedAfter.get(at) ?? []), removed]);
    }
    const changedIds = changedIdsOf(change);
    const changed = (node: string) => changedIds.includes(node);
    /** Whether a step of the frame shows its body: it is not one call (see stepCall), and it holds what opens it (see stepHolds) unless the reader flipped it. */
    const stepOpen = (node: TreeNode) => stepCall(node, enabled, options.hasFrame) === undefined && toggled.has(`${key}|${node.id}`) !== stepHolds(key, node, state, changedIds);
    /** The nodes of a list that are on and every node below them, the inside of a folded step left out. */
    const drawn = (nodes: readonly TreeNode[]): TreeNode[] => nodesOn(nodes, enabled).flatMap((node) => [node, ...(node.kind === 'block' && !stepOpen(node) ? [] : [...drawn(node.pre ?? []), ...branchesOf(node, enabled).flatMap((branch) => drawn(branch.nodes))])]);
    /** Whether a side can read on one line, as its row in the diagram does: no decision and no open step among its nodes and below them (inside a folded step aside), and at most one folded step, which the line names. */
    const rowable = (nodes: readonly TreeNode[]) => {
      const inside = drawn(nodes);
      return !inside.some((node) => DECISIONS.has(node.kind) || (node.kind === 'block' && stepOpen(node))) && inside.filter((node) => node.kind === 'block').length <= 1;
    };
    // The start of the root frame: its own row when the pull request changed the declaration (a frame opened below a call shows it on that call's row).
    if (key === '' && change !== undefined && (change.marks[''] !== undefined || (change.hunks[''] ?? []).length > 0)) rows.push({ kind: 'start', key: '|start', frame: key, depth, holds: [''], calls: [] });
    const removedRows = (at: string, depth: number) => {
      for (const removed of removedAfter.get(at) ?? []) rows.push({ kind: 'removed', key: `${key}|removed|${removed.node.id}|${at}`, frame: key, node: removed.node, depth });
    };
    const frameStateOf = (call: TreeNode): Extract<Row, { kind: 'node' }>['frameState'] => {
      const calleeId = call.target?.kind === 'function' ? call.target.id : undefined;
      if (calleeId === undefined || !options.hasFrame(calleeId)) return undefined;
      if (chain.includes(calleeId)) return 'recursion';
      return opened.has(childFrame(key, call.id)) ? (trees.has(calleeId) ? 'open' : 'loading') : 'closed';
    };
    const failsHere = (call: TreeNode | undefined) => call !== undefined && chosenSide(state.choices, decisionKey(key, call.id)) === FAILS;
    /** The rows of the frame a call opens, below its row. */
    const openBelow = (call: TreeNode, frameState: Extract<Row, { kind: 'node' }>['frameState'], depth: number) => {
      if ((frameState !== 'open' && frameState !== 'loading') || call.target?.kind !== 'function') return;
      const child = childFrame(key, call.id);
      frame(child, ids.get(child) ?? call.target.id, depth, [...chain, call.target.id]);
    };
    const list = (nodes: readonly TreeNode[], depth: number, parent: string, branchKey: string) => {
      removedRows(`${parent}|${branchKey}|start`, depth);
      const visible = nodesOn(nodes, enabled);
      for (let index = 0; index < visible.length; index += 1) {
        const node = visible[index] as TreeNode;
        // Statements in a row that say nothing in words read as one line, unless the pull request changed one of them.
        if (options.foldCode === true && silent(node) && !changed(node.id)) {
          let end = index;
          while (end + 1 < visible.length && silent(visible[end + 1] as TreeNode) && !changed((visible[end + 1] as TreeNode).id) && removedAfter.get((visible[end] as TreeNode).id) === undefined) end += 1;
          if (end > index) {
            const run = visible.slice(index, end + 1);
            const runKey = `${key}|run|${node.id}`;
            const open = toggled.has(runKey);
            rows.push({ kind: 'run', key: runKey, frame: key, nodes: run, depth, on: run.some((item) => on.has(item.id)), open, ...(open ? { holds: [], calls: [] } : heldBy(run)) });
            for (const item of run) {
              if (open) one(item, depth + 1);
              removedRows(item.id, open ? depth + 1 : depth);
            }
            index = end;
            continue;
          }
        }
        one(node, depth);
        removedRows(node.id, depth);
      }
    };
    const one = (node: TreeNode, depth: number, before = false): void => {
      const { call, others } = splitPre(node);
      for (const evaluated of others) one(evaluated, depth, true);
      if (node.kind === 'block') {
        step(node, depth);
        return;
      }
      const isOn = on.has(node.id);
      const opens = node.kind === 'call' ? node : call;
      const frameState = opens === undefined ? undefined : frameStateOf(opens);
      const head = {
        kind: 'node' as const,
        key: `${key}|${node.id}`,
        frame: key,
        node,
        depth,
        on: isOn,
        before,
        ...(call === undefined ? {} : { call }),
        ...(frameState === undefined ? {} : { frameState }),
        ...(failsHere(opens) ? { fails: true } : {}),
      };
      const own = call === undefined ? [node] : [node, call];
      if (node.branches === undefined || node.kind === 'action' || node.kind === 'call') {
        rows.push({ ...head, ...heldBy(own) });
        if (opens !== undefined) openBelow(opens, frameState, depth + 1);
        return;
      }
      const branches = branchesOf(node, enabled);
      const chosen = forcedSide(node, enabled) ?? chosenSide(state.choices, decisionKey(key, node.id));
      // A guard and an optional item read as one line: `if (!keys) → 終わり: …`.
      if (foldsGuard(node, enabled, options.hasFrame, changed)) {
        const yes = branches.find((branch) => branch.key === 'true');
        const side = yes === undefined ? [] : nodesOn(yes.nodes, enabled);
        rows.push({ ...head, exit: { nodes: side, on: isOn && (chosen === undefined || chosen === 'true') }, ...heldBy([...own, ...nodesBelow(side, enabled)]) });
        if (opens !== undefined) openBelow(opens, frameState, depth + 1);
        return;
      }
      rows.push({ ...head, ...heldBy(own) });
      if (opens !== undefined) openBelow(opens, frameState, depth + 1);
      // A try heads the rows it guards; its catch (and finally) follow them at its own depth.
      const sideDepth = node.kind === 'try' ? depth : depth + 1;
      for (const branch of branches) {
        const taken = chosen === undefined || branch.key === chosen || branch.always === true;
        const branchOn = (isOn && taken) || branch.nodes.some((child) => on.has(child.id));
        if (node.kind === 'try' && branch.key === 'try') {
          list(branch.nodes, depth + 1, node.id, branch.key);
          continue;
        }
        const shown = nodesOn(branch.nodes, enabled);
        const empty = shown.length === 0 && (removedAfter.get(`${node.id}|${branch.key}|start`) ?? []).length === 0;
        // A side with nothing in it needs no row (its chip on the decision chooses it), except a catch, which says that it lets the error go.
        if (empty && node.kind !== 'cond-expr' && node.kind !== 'try') continue;
        // A catch that ends at once reads on one line, as the row of its region in the diagram, until the reader opens a step in it there or here.
        const oneLine = node.kind === 'try' && (empty || (endsAtOnce(shown) && !shown.some((child) => changedIds.some((id) => id === child.id || below(id, child.id))) && rowable(shown)));
        const held = oneLine ? heldBy(nodesBelow(shown, enabled)) : { holds: [], calls: [] };
        const folded = oneLine ? drawn(shown).find((child) => child.kind === 'block' && stepCall(child, enabled, options.hasFrame) === undefined) : undefined;
        rows.push({ kind: 'branch', key: `${key}|${node.id}|${branch.key}`, frame: key, node, branch, depth: sideDepth, on: branchOn, chosen: chosen === branch.key, ...(oneLine ? { exit: { nodes: shown, on: branchOn } } : {}), ...(folded === undefined ? {} : { step: folded.id }), ...held });
        if (!oneLine) list(branch.nodes, sideDepth + 1, node.id, branch.key);
      }
    };
    const step = (node: TreeNode, depth: number) => {
      const rowKey = `${key}|${node.id}`;
      const isOn = on.has(node.id);
      const body = node.branches?.[0]?.nodes ?? [];
      const inside = nodesBelow(body, enabled);
      // A step that is one call of a function reads as that call: its row opens the function.
      const only = stepCall(node, enabled, options.hasFrame);
      if (only !== undefined) {
        const frameState = frameStateOf(only);
        rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before: false, call: only, ...(frameState === undefined ? {} : { frameState }), ...(failsHere(only) ? { fails: true } : {}), step: { open: false, merged: true, exits: [] }, ...heldBy([node, ...inside]) });
        openBelow(only, frameState, depth + 1);
        return;
      }
      const open = stepOpen(node);
      rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before: false, step: { open, merged: false, exits: open ? [] : exitsOf(inside).map((exit) => ({ node: exit, on: on.has(exit.id) })) }, ...heldBy(open ? [node] : [node, ...inside]) });
      if (open) list(body, depth + 1, node.id, 'body');
    };
    list(tree.nodes, depth, '', '');
  };
  frame('', options.rootId, 0, [options.rootId]);
  return rows;
}

/** The frames the outline shows (those with a row, a frame still loading among them), each by the index of its first row: the order the trace runs them. */
export function frameOrder(rows: readonly Row[]): Map<string, number> {
  const order = new Map<string, number>([['', 0]]);
  rows.forEach((row, index) => {
    if (!order.has(row.frame)) order.set(row.frame, index);
  });
  return order;
}

/** The frame a trace can show of the one it asks for: that frame when the outline shows it, else the nearest frame above it that the outline shows. */
export function shownFrame(key: string, shown: ReadonlyMap<string, number> | ReadonlySet<string>): string {
  let at: string | undefined = key;
  while (at !== undefined && at !== '' && !shown.has(at)) at = parentOf(at)?.frame;
  return at ?? '';
}

/**
 * The key of the outline row that shows a node of a frame: its own row, or
 * the row that stands for it (a condition or a return for the call evaluated
 * before it, a step for its one call), else the row that shows its nearest
 * ancestor in the same way (a guard or an optional item read on one line, a
 * folded step); undefined when none does, as for a frame the outline does
 * not show.
 */
export function rowFor(rows: readonly Row[], frame: string, node: string): string | undefined {
  const row = rows.find((candidate) => candidate.frame === frame && ((candidate.kind === 'node' && (candidate.node.id === node || candidate.call?.id === node)) || (candidate.kind === 'run' && !candidate.open && candidate.nodes.some((item) => item.id === node))));
  if (row !== undefined) return row.key;
  // An id is the id of the node it is under and its place there (`s0b1n0` under `s0b1`, `s5c1s0` under `s5`): trimming a segment at a time reaches every ancestor.
  const parent = node.replace(/[a-z]+[0-9]+$/, '');
  return parent === node || parent === '' ? undefined : rowFor(rows, frame, parent);
}

// ---- failures

/** The ancestors of a node in a list, outermost first, each with the branch the node is in. */
function ancestors(nodes: readonly TreeNode[], id: string): Array<{ node: TreeNode; branch?: string }> {
  for (const node of nodes) {
    if (node.id === id) return [];
    if (!id.startsWith(node.id)) continue;
    if (findNode(node.pre ?? [], id) !== undefined) return [{ node }, ...ancestors(node.pre ?? [], id)];
    for (const branch of node.branches ?? []) {
      if (findNode(branch.nodes, id) === undefined) continue;
      return [{ node, branch: branch.key }, ...ancestors(branch.nodes, id)];
    }
  }
  return [];
}

/** Where a failure of a node of a frame is caught: the innermost `try` with a `catch` around it, in its frame or in a frame that opened it. */
export function catcherOf(trees: ReadonlyMap<string, FlowTree>, ids: ReadonlyMap<string, string>, frame: string, node: string): { frame: string; node: TreeNode; id: string } | undefined {
  let key: string | undefined = frame;
  let at = node;
  while (key !== undefined) {
    const id = ids.get(key);
    const tree = id === undefined ? undefined : trees.get(id);
    if (tree === undefined || id === undefined) return undefined;
    const chain = ancestors(tree.nodes, at).reverse();
    for (const { node: around, branch } of chain) {
      if (around.kind === 'try' && branch === 'try' && (around.branches ?? []).some((side) => side.key === 'catch')) return { frame: key, node: around, id };
    }
    const parent = parentOf(key);
    if (parent === undefined) return undefined;
    key = parent.frame;
    at = parent.node;
  }
  return undefined;
}
