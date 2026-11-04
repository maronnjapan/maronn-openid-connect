/**
 * The choices the map offers ready-made for a frame (よく使う選択), computed
 * from its tree with no enumeration of paths, so there is no limit and no
 * fallback:
 *
 * - exits: for every return, throw and the end of the body, the sides that
 *   lead there. It is named by the decisions it is inside of only: the
 *   guards it passes are chosen (on their side that goes on) but not named.
 * - steps (an endpoint): for a block whose way in needs a decision, or whose
 *   value a later decision tests (`const exchanged = ...; if (exchanged)
 *   return exchanged`), the sides that lead into it and use its value. It is
 *   named by the step's label.
 * - failures from below (failureSelections): for each failure a call of the
 *   frame can bring up from the functions below, the frames down to the
 *   throw and the sides that lead there, each call on the way decided
 *   `fails` (the call throws there: the trace runs the failure up to the
 *   `try` that catches it, or out of the frame), a `try` around the way left
 *   undecided. It is named by the failure and the function that throws it:
 *   `TokenError(invalid_client) で終わる（verifyClientSecret から）`.
 *
 * Two choices that the sides do not tell apart (two catches that both
 * `return null`) name each catch by what its try runs first
 * (「`formUrlDecode()` で例外が起きたとき」), then by where they end, and only
 * then by a number.
 *
 * The decisions of a choice are keyed by node id; a choice that spans frames
 * (a way to a change, changes.ts) prefixes them with the frame (Decisions).
 */
import { outlets } from './failures.js';
import type { Branch, Decisions, Failure, FlowTree, Selection, TreeNode } from './model.js';
import { ends } from './tree.js';
import type { ValueUse } from './tree.js';
import { shorten } from './words.js';

/** The kinds of node a choice is made at. */
const DECISIONS = new Set(['if', 'switch', 'try', 'cond-expr', 'loop']);

/** What it takes to reach a node: the sides chosen, and those of the decisions it is inside of. */
export interface Way {
  decisions: Decisions;
  /** The decisions the node is inside of, with the side: what names the way. */
  inside: Array<{ node: TreeNode; branch: Branch }>;
}

/** The sides that let a list run on past a node that could end the frame there. */
function pass(node: TreeNode, decisions: Decisions): void {
  if (node.kind === 'block') {
    for (const child of node.branches?.[0]?.nodes ?? []) pass(child, decisions);
    return;
  }
  if (!DECISIONS.has(node.kind) || node.kind === 'loop') return;
  const branches = (node.branches ?? []).filter((branch) => branch.always !== true);
  const going = branches.filter((branch) => !ends(branch.nodes));
  if (going.length === branches.length) return;
  if (going.length === 1) {
    const only = going[0] as Branch;
    decisions[node.id] = only.key;
    for (const child of only.nodes) pass(child, decisions);
  }
}

/** The way to the node of a tree with an id, or undefined when the tree has none. */
export function wayTo(nodes: readonly TreeNode[], id: string): Way | undefined {
  const decisions: Decisions = {};
  const inside: Way['inside'] = [];
  const search = (list: readonly TreeNode[]): boolean => {
    for (const node of list) {
      if (node.id === id || id.startsWith(node.id) && contains(node, id)) {
        if (node.id === id) return true;
        if (node.pre !== undefined && search(node.pre)) return true;
        for (const branch of node.branches ?? []) {
          if (!branch.nodes.some((child) => child.id === id || contains(child, id))) continue;
          if (DECISIONS.has(node.kind) && branch.always !== true) {
            decisions[node.id] = branch.key;
            inside.push({ node, branch });
          }
          return search(branch.nodes);
        }
        return false;
      }
      pass(node, decisions);
    }
    return false;
  };
  return search(nodes) ? { decisions, inside } : undefined;
}

/** Whether a node or one below it has an id. */
function contains(node: TreeNode, id: string): boolean {
  if (node.id === id) return true;
  if (!id.startsWith(node.id)) return false;
  return (node.pre ?? []).some((child) => contains(child, id)) || (node.branches ?? []).some((branch) => branch.nodes.some((child) => contains(child, id)));
}

/** The words of one side of a decision in a name: `exchanged: 成立`, `例外が起きたとき`. */
export function sideName(node: TreeNode, branch: Branch): string {
  if (node.kind === 'try') return branch.label;
  if (node.kind === 'switch') return `${node.subject ?? ''}: ${branch.label}`;
  return `${node.subject ?? node.code}: ${branch.label}`;
}

/**
 * What a `try` runs first, in words: its first call (`` `formUrlDecode()` ``,
 * with `code` as it is called, `` `formUrlDecode(body)` ``), else its first
 * statement; empty for an empty try.
 */
function attemptWords(node: TreeNode, code: boolean): string {
  const attempt = node.branches?.find((branch) => branch.key === 'try')?.nodes ?? [];
  const call = [...all(attempt)].find((child) => child.kind === 'call');
  if (call?.target !== undefined && call.target.kind !== 'untraceable' && !code) return `\`${call.target.id.slice(call.target.id.indexOf('#') + 1)}()\``;
  const first = call ?? attempt[0];
  return first === undefined ? '' : `\`${shorten(first.code.replace(/^(?:const|let|var)?\s*[^=(]+=\s*(?:await\s+)?/, ''), 40)}\``;
}

/**
 * The name of a way: the sides it is inside of, the plain run of a try left
 * out; a catch named by what its try runs first with `tries` (by its callee,
 * or by the call as it is written).
 */
function nameOf(way: Way, tries?: 'callee' | 'call'): string {
  return way.inside
    .filter(({ node, branch }) => !(node.kind === 'try' && branch.key === 'try') && node.kind !== 'loop')
    .map(({ node, branch }) => {
      const attempt = tries !== undefined && node.kind === 'try' && branch.key === 'catch' ? attemptWords(node, tries === 'call') : '';
      return attempt === '' ? sideName(node, branch) : `${attempt} で${branch.label}`;
    })
    .join(' › ');
}

/** The names of choices counted, to find the ones a name does not tell apart. */
function repeated(selections: readonly Selection[]): Set<string> {
  const counts = new Map<string, number>();
  for (const selection of selections) counts.set(selection.name, (counts.get(selection.name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/** Every node of a list, depth first. */
function* all(nodes: readonly TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    if (node.pre !== undefined) yield* all(node.pre);
    for (const branch of node.branches ?? []) yield* all(branch.nodes);
  }
}

/** Whether two choices choose the same sides. */
function same(a: Decisions, b: Decisions): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** The choices of a frame (see the module comment); `uses` are the values of its blocks that decisions test. */
export function frameSelections(tree: FlowTree, uses: ReadonlyMap<TreeNode, readonly ValueUse[]> = new Map()): Selection[] {
  const steps: Selection[] = [];
  for (const node of all(tree.nodes)) {
    if (node.kind !== 'block' || node.step === undefined) continue;
    const way = wayTo(tree.nodes, node.id);
    if (way === undefined) continue;
    const decisions: Decisions = { ...way.decisions };
    let named = way.inside.some(({ node: decision, branch }) => !(decision.kind === 'try' && branch.key === 'try') && decision.kind !== 'loop');
    // The sides every call of the step is on (`refreshTokenRequest ?? validateAuthorizationCodeGrant(…)`: the call runs on one side only).
    const calls = [...all(node.branches?.[0]?.nodes ?? [])].filter((child) => child.kind === 'call');
    const ways = calls.map((call) => wayTo(tree.nodes, call.id)).filter((candidate): candidate is Way => candidate !== undefined);
    const common = ways.length === 0 ? [] : (ways[0] as Way).inside.filter(({ node: decision, branch }) => decision.id.startsWith(node.id) && ways.every((other) => other.inside.some((entry) => entry.node === decision && entry.branch === branch)));
    for (const { node: decision, branch } of common) {
      decisions[decision.id] = branch.key;
      named = true;
    }
    let note: string | undefined;
    for (const use of uses.get(node) ?? []) {
      const present = use.decision.branches?.find((branch) => branch.key === use.present);
      const absent = use.decision.branches?.find((branch) => branch.key === use.absent);
      // A side that answers with the value (`if (exchanged) return exchanged`) or a fork on it tells the step apart; a guard that only lets it through does not.
      const answers = present?.nodes.some((child) => child.kind === 'return' && child.code === `return ${use.name}`) === true;
      const forks = use.decision.kind === 'cond-expr' || (use.decision.form === 'fork' && present !== undefined && !ends(present.nodes) && !(absent !== undefined && ends(absent.nodes)));
      const tells = answers || forks;
      if (!tells) continue;
      const into = wayTo(tree.nodes, use.decision.id);
      if (into !== undefined) Object.assign(decisions, into.decisions);
      decisions[use.decision.id] = use.present;
      named = true;
      const exit = present?.nodes.find((child) => child.kind === 'return' || child.kind === 'throw');
      if (exit !== undefined) note = `→ ${exit.code}`;
    }
    if (!named) continue;
    steps.push({ kind: 'step', name: node.step.label, ...(note === undefined ? {} : { note }), decisions, target: node.id });
  }
  const exits: Selection[] = [];
  const ways = new Map<Selection, Way>();
  for (const node of all(tree.nodes)) {
    const isExit = (node.kind === 'return' && node.local !== true) || node.kind === 'throw' || node.kind === 'end';
    if (!isExit) continue;
    const way = wayTo(tree.nodes, node.id);
    if (way === undefined) continue;
    if (steps.some((step) => same(step.decisions, way.decisions))) continue;
    const name = nameOf(way);
    const code = node.kind === 'end' ? '最後まで進んで終わる' : node.code;
    const exit: Selection = { kind: node.kind === 'throw' ? 'failure' : 'exit', name: name === '' ? code : name, note: `→ ${code}`, decisions: way.decisions, target: node.id };
    if (node.kind === 'throw') exit.failure = { error: node.error ?? 'Error', from: tree.id, name: tree.name };
    exits.push(exit);
    ways.set(exit, way);
  }
  // Names the sides do not tell apart name each catch by its try, then get where they end, then a number.
  const named = [...steps, ...exits];
  let shared = repeated(named);
  for (const tries of ['callee', 'call'] as const) {
    for (const selection of exits) {
      const way = ways.get(selection);
      if (!shared.has(selection.name) || way === undefined) continue;
      const qualified = nameOf(way, tries);
      if (qualified !== '') selection.name = qualified;
    }
    shared = repeated(named);
  }
  for (const selection of named) {
    if (shared.has(selection.name) && selection.note !== undefined && selection.kind !== 'step' && !selection.name.endsWith(selection.note)) selection.name = `${selection.name} ${selection.note}`;
  }
  const seen = new Map<string, number>();
  for (const selection of named) {
    const count = (seen.get(selection.name) ?? 0) + 1;
    seen.set(selection.name, count);
    if (count > 1) selection.name = `${selection.name} (${count})`;
  }
  return named;
}

/** Prefix the decisions of a frame's choice with the frame's key (the chain of call nodes that opened it). */
export function inFrame(decisions: Decisions, frame: string): Decisions {
  if (frame === '') return { ...decisions };
  return Object.fromEntries(Object.entries(decisions).map(([key, side]) => [`${frame}.${key}`, side]));
}

/** The key of a node of a frame, or of the frame a call node opens. */
function keyIn(frame: string, node: string): string {
  return frame === '' ? node : `${frame}.${node}`;
}

/** The decisions that lead to a node of a frame, keyed for the frame, the tries in `undecided` left out. */
function decisionsTo(tree: FlowTree, id: string, frame: string, undecided: readonly string[]): Decisions {
  const decisions = { ...(wayTo(tree.nodes, id)?.decisions ?? {}) };
  for (const key of undecided) delete decisions[key];
  return inFrame(decisions, frame);
}

/**
 * The failures a frame's calls bring up from below (see the module comment),
 * a failure once (the first way to it in the order of the code). `failures`
 * are what leaves each frame (escapingFailures); `nameOf` names a function.
 */
export function failureSelections(rootId: string, trees: ReadonlyMap<string, FlowTree>, failures: ReadonlyMap<string, readonly Failure[]>, nameOf: (id: string) => string): Selection[] {
  const root = trees.get(rootId);
  if (root === undefined) return [];
  const leaves = (id: string, failure: Failure) => (failures.get(id) ?? []).some((other) => other.error === failure.error && other.from === failure.from);
  type Found = { frames: string[]; decisions: Decisions; target: string; code: string };
  const find = (id: string, frame: string, failure: Failure, visited: ReadonlySet<string>): Found | undefined => {
    const tree = trees.get(id);
    if (tree === undefined) return undefined;
    for (const outlet of outlets(tree.nodes)) {
      // Below the root, a failure has to leave the frame to get up to it.
      if (outlet.caught && id !== rootId) continue;
      const { node } = outlet;
      if (node.kind === 'throw') {
        if (failure.from !== id || (node.error ?? 'Error') !== failure.error) continue;
        return { frames: [], decisions: decisionsTo(tree, node.id, frame, outlet.tries), target: keyIn(frame, node.id), code: node.code };
      }
      const callee = node.target?.kind === 'function' ? node.target.id : undefined;
      if (callee === undefined || visited.has(callee) || !leaves(callee, failure)) continue;
      const child = keyIn(frame, node.id);
      const below = find(callee, child, failure, new Set([...visited, callee]));
      if (below === undefined) continue;
      return { ...below, frames: [child, ...below.frames], decisions: { ...decisionsTo(tree, node.id, frame, outlet.tries), ...below.decisions } };
    }
    return undefined;
  };
  // The failures the calls of the frame can bring up, in the order of the calls.
  const candidates = new Map<string, Failure>();
  for (const outlet of outlets(root.nodes)) {
    if (outlet.node.kind !== 'call' || outlet.node.target?.kind !== 'function') continue;
    for (const failure of failures.get(outlet.node.target.id) ?? []) {
      if (failure.from === rootId) continue;
      const key = `${failure.error}\u0000${failure.from}`;
      if (!candidates.has(key)) candidates.set(key, failure);
    }
  }
  const selections: Selection[] = [];
  for (const failure of candidates.values()) {
    const found = find(rootId, '', failure, new Set([rootId]));
    if (found === undefined) continue;
    const name = nameOf(failure.from);
    // Each call on the way throws there (`fails`, see Decisions).
    const decisions: Decisions = { ...found.decisions, ...Object.fromEntries(found.frames.map((key) => [key, 'fails'])) };
    selections.push({ kind: 'failure', name: `\`${failure.error}\` で終わる（\`${name}\` から）`, note: `→ ${found.code}`, decisions, frames: found.frames, target: found.target, failure: { ...failure, name } });
  }
  return selections;
}
