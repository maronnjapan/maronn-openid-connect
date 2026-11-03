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
import type { Branch, Decisions, FlowTree, FrameChange, MapData, RemovedNode, TreeNode } from '../types';

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

/** The frame a key's frame was opened from, and the call node that opened it; undefined for the root. */
export function parentOf(key: string): { frame: string; node: string } | undefined {
  if (key === '') return undefined;
  const dot = key.lastIndexOf('.');
  return dot === -1 ? { frame: '', node: key } : { frame: key.slice(0, dot), node: key.slice(dot + 1) };
}

/** What a frame id names in the index: a function of the catalog or an endpoint body. */
export function entryOf(data: MapData, id: string): MapData['functions'][string] | MapData['bodies'][string] | undefined {
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

/** Whether a node is a decision a reader can choose a side of. */
export function isDecision(node: TreeNode): boolean {
  return DECISIONS.has(node.kind) && (node.branches ?? []).filter((branch) => branch.always !== true).length > 1;
}

/**
 * Mark the nodes of a list a choice runs; returns whether the list goes on
 * past its end (false when every way through it returns or throws).
 */
function run(nodes: readonly TreeNode[], frame: string, choice: Decisions, enabled: ReadonlySet<string> | undefined, running: boolean, on: Set<string>): boolean {
  let going = running;
  for (const node of nodesOn(nodes, enabled)) {
    if (!going) continue;
    on.add(node.id);
    if (node.pre !== undefined) run(node.pre, frame, choice, enabled, true, on);
    switch (node.kind) {
      case 'return':
        if (node.local !== true) going = false;
        break;
      case 'throw':
        going = false;
        break;
      case 'block':
        going = run(node.branches?.[0]?.nodes ?? [], frame, choice, enabled, true, on);
        break;
      default: {
        if (node.branches === undefined) break;
        const forced = forcedSide(node, enabled);
        const chosen = forced ?? choice[decisionKey(frame, node.id)];
        let anyGoes = false;
        let finallyGoes = true;
        for (const branch of branchesOf(node, enabled)) {
          if (branch.always === true) {
            finallyGoes = run(branch.nodes, frame, choice, enabled, true, on);
            continue;
          }
          const taken = chosen === undefined || branch.key === chosen;
          const goes = run(branch.nodes, frame, choice, enabled, taken, on);
          if (taken && goes) anyGoes = true;
        }
        if (node.kind === 'loop') anyGoes = true;
        if (node.kind === 'switch' && chosen === undefined) anyGoes = true;
        going = anyGoes && finallyGoes;
      }
    }
  }
  return going;
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

/** The changes of a map by frame id, and what each frame reaches below it. */
export interface ChangeReach {
  /** The changed frames (their code) by id, with how many changes of each kind. */
  changed: ReadonlyMap<string, Record<string, number>>;
  /** The changed frames a frame leads to through its calls (itself left out), by id. */
  below(id: string): ReadonlySet<string>;
}

/** What reaches the changes of a map (see ChangeReach); undefined for a map without changes. */
export function changeReach(data: MapData): ChangeReach | undefined {
  const changes = data.changes;
  if (changes === undefined) return undefined;
  const changed = new Map<string, Record<string, number>>();
  for (const entry of changes.frames) {
    if (entry.kind === 'added' || entry.kind === 'modified') changed.set(entry.id, entry.counts);
  }
  // A changed implementation of a member counts at every call of the member.
  const members = new Map<string, string[]>();
  for (const entry of changes.frames) for (const member of entry.members ?? []) members.set(member, [...(members.get(member) ?? []), entry.id]);
  const memo = new Map<string, Set<string>>();
  const below = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const found = new Set<string>();
    memo.set(id, found);
    const entry = entryOf(data, id);
    for (const [, callee] of entry?.sites ?? []) {
      for (const implementer of members.get(callee) ?? []) found.add(implementer);
      if (changed.has(callee)) found.add(callee);
      for (const deeper of below(callee)) found.add(deeper);
    }
    found.delete(id);
    return found;
  };
  return { changed, below };
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

/** A row of the outline. */
export type Row =
  | { kind: 'node'; key: string; frame: string; node: TreeNode; depth: number; on: boolean; before: boolean; frameState?: 'open' | 'closed' | 'recursion' | 'loading'; folded?: string }
  | { kind: 'branch'; key: string; frame: string; node: TreeNode; branch: Branch; depth: number; on: boolean; folded?: string }
  | { kind: 'actions'; key: string; frame: string; nodes: TreeNode[]; depth: number; on: boolean }
  | { kind: 'removed'; key: string; frame: string; node: TreeNode; depth: number }
  | { kind: 'loading'; key: string; frame: string; depth: number };

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
  /** The rows the reader unfolded (a guard, a run of actions, a side not chosen), by row key. */
  unfolded?: ReadonlySet<string>;
}

/** A side folded to one line: its nodes in words. */
export function foldedWords(nodes: readonly TreeNode[]): string {
  if (nodes.length === 0) return '何もしない';
  const exit = [...nodes].reverse().find((node) => node.kind === 'return' || node.kind === 'throw');
  const calls = nodes.filter((node) => node.kind === 'call').length;
  const others = nodes.length - calls - (exit === undefined ? 0 : 1);
  const parts: string[] = [];
  if (calls > 0) parts.push(`呼び出し ${calls}`);
  if (others > 0) parts.push(`処理 ${others}`);
  const head = parts.length === 0 ? '' : `${parts.join('、')}、`;
  return exit === undefined ? `${head}そのまま進む`.replace(/、そのまま/, 'のあとそのまま') : `${head}${exit.code} で終わる`;
}

/** The rows of the outline of a trace (see Row): each frame's tree indented below the call that opened it. */
export function traceRows(options: RowOptions): Row[] {
  const { trees, state, enabled } = options;
  const unfolded = options.unfolded ?? new Set<string>();
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
    const removedRows = (at: string, depth: number) => {
      for (const removed of removedAfter.get(at) ?? []) rows.push({ kind: 'removed', key: `${key}|removed|${removed.node.id}|${at}`, frame: key, node: removed.node, depth });
    };
    const list = (nodes: readonly TreeNode[], depth: number, parent: string, branchKey: string) => {
      removedRows(`${parent}|${branchKey}|start`, depth);
      const visible = nodesOn(nodes, enabled);
      for (let index = 0; index < visible.length; index += 1) {
        const node = visible[index] as TreeNode;
        // A run of actions reads as one row until it is unfolded.
        if (node.kind === 'action' && change?.marks[node.id] === undefined) {
          let end = index;
          while (end + 1 < visible.length && (visible[end + 1] as TreeNode).kind === 'action' && change?.marks[(visible[end + 1] as TreeNode).id] === undefined && removedAfter.get((visible[end] as TreeNode).id) === undefined) end += 1;
          const runKey = `${key}|actions|${node.id}`;
          if (end > index && !unfolded.has(runKey)) {
            const run = visible.slice(index, end + 1);
            rows.push({ kind: 'actions', key: runKey, frame: key, nodes: run, depth, on: run.some((item) => on.has(item.id)) });
            for (const item of run) removedRows(item.id, depth);
            index = end;
            continue;
          }
        }
        one(node, depth);
        removedRows(node.id, depth);
      }
    };
    const one = (node: TreeNode, depth: number, before = false) => {
      for (const evaluated of node.pre ?? []) one(evaluated, depth, true);
      const rowKey = `${key}|${node.id}`;
      const isOn = on.has(node.id);
      if (node.kind === 'call') {
        const target = node.target;
        const child = childFrame(key, node.id);
        const calleeId = target?.kind === 'function' ? target.id : undefined;
        const frameState = calleeId === undefined || !options.hasFrame(calleeId) ? undefined : chain.includes(calleeId) ? 'recursion' : opened.has(child) ? (trees.has(calleeId) ? 'open' : 'loading') : 'closed';
        rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before, ...(frameState === undefined ? {} : { frameState }) });
        if (frameState === 'open' || frameState === 'loading') frame(child, ids.get(child) ?? (calleeId as string), depth + 1, [...chain, calleeId as string]);
        return;
      }
      if (node.kind === 'block') {
        rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before: false });
        list(node.branches?.[0]?.nodes ?? [], depth + 1, node.id, 'body');
        return;
      }
      if (node.branches === undefined || node.kind === 'action') {
        rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before });
        return;
      }
      const branches = branchesOf(node, enabled);
      const chosen = forcedSide(node, enabled) ?? chosenSide(state.choices, decisionKey(key, node.id));
      // A guard and an optional item read as one line: `if (!x) → throw ...`.
      if ((node.form === 'guard' || node.form === 'optional') && !unfolded.has(rowKey) && change?.marks[node.id] === undefined && !branches.some((branch) => branch.nodes.some((child) => change?.marks[child.id] !== undefined))) {
        const yes = branches.find((branch) => branch.key === 'true');
        const shown = yes === undefined ? [] : nodesOn(yes.nodes, enabled);
        const words = shown.length === 0 ? '' : node.form === 'guard' ? `→ ${foldedWords(shown)}` : `→ ${shown.map((child) => child.code).join('、')}`;
        rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before: false, folded: words });
        return;
      }
      rows.push({ kind: 'node', key: rowKey, frame: key, node, depth, on: isOn, before: false });
      for (const branch of branches) {
        const branchKey = `${rowKey}|${branch.key}`;
        const empty = branch.nodes.length === 0 && (removedAfter.get(`${node.id}|${branch.key}|start`) ?? []).length === 0;
        // A side with nothing in it needs no row: its chip on the decision chooses it.
        if (empty && node.kind !== 'cond-expr') continue;
        const other = chosen !== undefined && branch.key !== chosen && branch.always !== true;
        const branchOn = branch.nodes.some((child) => on.has(child.id)) || (isOn && !other);
        if (other && !unfolded.has(branchKey)) {
          rows.push({ kind: 'branch', key: branchKey, frame: key, node, branch, depth: depth + 1, on: false, folded: foldedWords(nodesOn(branch.nodes, enabled)) });
          continue;
        }
        rows.push({ kind: 'branch', key: branchKey, frame: key, node, branch, depth: depth + 1, on: branchOn });
        list(branch.nodes, depth + 2, node.id, branch.key);
      }
    };
    list(tree.nodes, depth, '', '');
  };
  frame('', options.rootId, 0, [options.rootId]);
  return rows;
}

/**
 * The key of the outline row that shows a node of a frame: its own row, else
 * the run of actions folded to one row that holds it, else the row that shows
 * its nearest ancestor in the same way (a guard or an optional item folded to
 * one line, a decision whose side is folded); undefined when none does, as
 * for a frame the outline does not show.
 */
export function rowFor(rows: readonly Row[], frame: string, node: string): string | undefined {
  const row = rows.find((candidate) => candidate.frame === frame && (candidate.kind === 'node' ? candidate.node.id === node : candidate.kind === 'actions' && candidate.nodes.some((item) => item.id === node)));
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
