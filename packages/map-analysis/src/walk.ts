/**
 * The walk of one request through a frame: the nodes of its tree in the order
 * they run on one way, down into the frames of the calls the walk is told to
 * enter, and up again with a failure to the `try` that catches it.
 *
 * A choice (Decisions) names a side of some decisions; a walk needs a side of
 * every decision it meets, so it assumes one where the choice names none: the
 * first side that does not end the frame at once (a guard is passed, a `try`
 * runs without an exception, a loop runs its body once). The sides it assumed
 * are told apart from the chosen ones, so a page can offer the others.
 *
 * - A call the choice decides `fails` (FAILS) throws there. A call whose
 *   frame the walk enters fails when that frame does, whatever the choice
 *   says: the walk is what runs.
 * - A failure goes up to the innermost `try` with a `catch` around it in its
 *   frame, whose catch runs (a stop on the `try` says so), then up through
 *   the call that opened the frame; with no `try` on the way it leaves the
 *   root frame.
 * - A `try` the choice decides `catch` with no failure in sight skips its
 *   body: an exception somewhere in it is all the choice says.
 *
 * This module is plain data in and out and imports only types, so the page
 * of the map (apps/map) and the test catalog (packages/test-catalog) share
 * it: `@maronn-openid-connect/map-analysis/walk`.
 */
import type { Branch, Decisions, FlowTree, TreeNode } from './model.js';

/** The side a choice gives a call node to say that the call throws there (Decisions). */
export const FAILS = 'fails';

/** The kinds of node that take a side. */
const DECISIONS: ReadonlySet<string> = new Set(['if', 'switch', 'loop', 'try', 'cond-expr']);

/** Whether a list ends the frame whatever its decisions choose. */
export function ends(nodes: readonly TreeNode[]): boolean {
  return nodes.some(endsNode);
}

/** Whether a node ends the frame whatever its decisions choose. */
function endsNode(node: TreeNode): boolean {
  switch (node.kind) {
    case 'return':
      return node.local !== true;
    case 'throw':
      return true;
    case 'if':
      return (node.branches ?? []).length === 2 && (node.branches ?? []).every((branch) => ends(branch.nodes));
    case 'switch': {
      const branches = node.branches ?? [];
      if (!branches.some((branch) => branch.key === 'default' || branch.label === 'default')) return false;
      return branches.every((branch, index) => ends(branch.nodes) || (branch.fallsThrough === true && index < branches.length - 1));
    }
    case 'try': {
      const branches = node.branches ?? [];
      const attempt = branches.find((branch) => branch.key === 'try');
      const handler = branches.find((branch) => branch.key === 'catch');
      const final = branches.find((branch) => branch.key === 'finally');
      if (final !== undefined && ends(final.nodes)) return true;
      return attempt !== undefined && ends(attempt.nodes) && (handler === undefined || ends(handler.nodes));
    }
    case 'block':
      return ends(node.branches?.[0]?.nodes ?? []);
    default:
      return false;
  }
}

/** What happens at a stop besides the node running (see WalkStop.event). */
export type WalkEvent = 'enters' | 'returns' | 'ends' | 'throws' | 'fails' | 'catches';

/** One stop of a walk: a node the request reaches, in the order it runs. */
export interface WalkStop {
  /** The key of the frame the node is in: '' for the frame the walk starts in, else the chain of call nodes that opened it (`s0b1s0`, `s0b1s0.s2`). */
  frame: string;
  /** The id of that frame's tree (`endpoint:token`, `core:client-auth.ts#verifyClientSecret`). */
  tree: string;
  node: TreeNode;
  /** How many frames the walk is below the one it started in. */
  depth: number;
  /** The step of its frame the node is or is in: the nearest block or call that carries a step mark. */
  step?: string;
  /** For a decision: the side the walk takes, and whether it assumed it (the choice named none). */
  side?: { key: string; label: string; assumed: boolean };
  /**
   * enters: the walk goes into the frame of this call; returns: this return
   * ends its frame; ends: the body ends without a return; throws: this throw
   * fails; fails: this call fails here (the choice says so, and the walk did
   * not see the throw below it); catches: the catch of this `try` takes the
   * failure, or runs because the choice says so.
   */
  event?: WalkEvent;
  /** The failure in words (`TokenError(invalid_client)`), where it is thrown, where it comes up through a call and where it is caught, when the tree names it. */
  error?: string;
}

/** A walk (see the module comment). */
export interface FlowWalk {
  stops: WalkStop[];
  /** How the frame it started in ends: it returns (or its body ends), or a failure leaves it. */
  outcome: 'returns' | 'fails';
  /** The failure that leaves it, when the tree names it. */
  error?: string;
  /**
   * The side taken at every decision met, the assumed ones included, and
   * `fails` at every call a failure came up through, keyed like Decisions. A
   * `try` whose body failed keeps the side the choice gave it (none, most
   * often): its body and its catch both ran.
   */
  resolved: Decisions;
  /** The keys of the decisions whose side the walk assumed. */
  assumed: string[];
  /** The walk stopped at its limit of stops before the frame ended. */
  cut?: true;
}

/** How a walk reads its tree (see walkFlow). */
export interface WalkOptions {
  /** The key of the frame the tree is; '' unless the walk starts below a root. */
  frame?: string;
  /** The markers of the features that are on (`refresh-token`): a node of a feature that is off is left out, and a decision that reads its value keeps one side. All on when absent. */
  enabled?: ReadonlySet<string>;
  /**
   * The tree of the frame a call opens (`key`, its frame key), to go into
   * it; undefined to step over the call. A frame already on the way down
   * (recursion) is never entered.
   */
  enter?: (key: string, call: TreeNode) => FlowTree | undefined;
  /** The most stops a walk makes (5000 when absent): a guard, never reached by a tree of the map. */
  limit?: number;
}

/** How running a list comes out: it goes on, its frame returns, or a failure leaves it. */
type Flow = 'goes' | 'returns' | 'fails';

/** The decision key of a node of a frame, and the key of the frame a call node opens: the same join. */
function keyOf(frame: string, node: string): string {
  return frame === '' ? node : `${frame}.${node}`;
}

/** Whether a feature a node names is on. */
function featureOn(enabled: ReadonlySet<string> | undefined, feature: string | undefined): boolean {
  return feature === undefined || enabled === undefined || enabled.has(feature);
}

/** The side a decision must take with the features that are on, or undefined. */
function forcedSide(node: TreeNode, enabled: ReadonlySet<string> | undefined): string | undefined {
  return node.absent !== undefined && !featureOn(enabled, node.absent.feature) ? node.absent.side : undefined;
}

/**
 * The side a walk assumes at a decision the choice does not decide: a `try`
 * runs without an exception, a loop runs its body, and any other takes its
 * first side that does not end the frame at once (so a guard is passed), else
 * its first side.
 */
export function assumedSide(node: TreeNode, sides: readonly Branch[]): Branch | undefined {
  if (node.kind === 'try') return sides.find((branch) => branch.key === 'try') ?? sides[0];
  if (node.kind === 'loop') return sides.find((branch) => branch.key === 'body') ?? sides[0];
  return sides.find((branch) => !ends(branch.nodes)) ?? sides[0];
}

/**
 * Walk a tree along a choice (see the module comment): `decisions` names the
 * sides chosen, keyed `<frame>.<node>` (the starting frame's by the node
 * alone), and FAILS at the calls that throw.
 */
export function walkFlow(tree: FlowTree, decisions: Decisions, options: WalkOptions = {}): FlowWalk {
  const { enabled, enter } = options;
  const limit = options.limit ?? 5000;
  const stops: WalkStop[] = [];
  const resolved: Decisions = {};
  const assumed: string[] = [];
  // The failure on its way up, in words; undefined when the tree does not name it.
  let failure: string | undefined;
  let cut = false;

  const shown = (nodes: readonly TreeNode[]): TreeNode[] => nodes.filter((node) => featureOn(enabled, node.feature));
  const sidesOf = (node: TreeNode): Branch[] => {
    const forced = forcedSide(node, enabled);
    return (node.branches ?? []).filter((branch) => forced === undefined || branch.key === forced || branch.always === true);
  };

  /** The frame being walked: its key, its tree, how deep it is, the trees on the way down to it, and the step the nodes are in. */
  interface Frame {
    key: string;
    tree: FlowTree;
    depth: number;
    chain: readonly string[];
  }

  const push = (frame: Frame, node: TreeNode, step: string | undefined, extra: Partial<WalkStop> = {}): WalkStop => {
    const stop: WalkStop = { frame: frame.key, tree: frame.tree.id, node, depth: frame.depth, ...(step === undefined ? {} : { step }), ...extra };
    stops.push(stop);
    if (stops.length >= limit) cut = true;
    return stop;
  };

  const list = (nodes: readonly TreeNode[], frame: Frame, step: string | undefined): Flow => {
    for (const node of shown(nodes)) {
      if (cut) return 'returns';
      const flow = one(node, frame, step);
      if (flow !== 'goes') return flow;
    }
    return 'goes';
  };

  const one = (node: TreeNode, frame: Frame, outer: string | undefined): Flow => {
    const step = node.step?.id ?? outer;
    // What is evaluated before the node runs first: the arguments of a call, the calls of a condition.
    const before = list(node.pre ?? [], frame, step);
    if (before !== 'goes') return before;
    const key = keyOf(frame.key, node.id);
    switch (node.kind) {
      case 'call':
        return call(node, frame, step, key);
      case 'return':
        push(frame, node, step, node.local === true ? {} : { event: 'returns' });
        return node.local === true ? 'goes' : 'returns';
      case 'throw':
        failure = node.error;
        push(frame, node, step, { event: 'throws', ...(node.error === undefined ? {} : { error: node.error }) });
        return 'fails';
      case 'end':
        push(frame, node, step, { event: 'ends' });
        return 'goes';
      case 'block':
        push(frame, node, step);
        return list(node.branches?.[0]?.nodes ?? [], frame, step);
      case 'try':
        return attempt(node, frame, step, key);
      default:
        if (node.branches === undefined || !DECISIONS.has(node.kind)) {
          push(frame, node, step);
          return 'goes';
        }
        return decide(node, frame, step, key);
    }
  };

  /** A call: into its frame when the walk enters it, failing where the choice or that frame says so. */
  const call = (node: TreeNode, frame: Frame, step: string | undefined, key: string): Flow => {
    const decidedToFail = decisions[key] === FAILS;
    const callee = node.target?.kind === 'function' ? node.target.id : undefined;
    const inner = callee === undefined || frame.chain.includes(callee) ? undefined : enter?.(key, node);
    if (inner === undefined) {
      if (!decidedToFail) {
        push(frame, node, step);
        return 'goes';
      }
      failure = undefined;
      resolved[key] = FAILS;
      push(frame, node, step, { event: 'fails' });
      return 'fails';
    }
    push(frame, node, step, { event: 'enters' });
    const flow = list(inner.nodes, { key, tree: inner, depth: frame.depth + 1, chain: [...frame.chain, inner.id] }, undefined);
    if (flow === 'fails') {
      resolved[key] = FAILS;
      return 'fails';
    }
    if (decidedToFail && !cut) {
      // The choice says the call fails, and the way through its frame did not throw: it fails here.
      failure = undefined;
      resolved[key] = FAILS;
      push(frame, node, step, { event: 'fails' });
      return 'fails';
    }
    return 'goes';
  };

  /** A `try`: its body, its catch when the body fails (or the choice takes it), then its finally. */
  const attempt = (node: TreeNode, frame: Frame, step: string | undefined, key: string): Flow => {
    const branches = sidesOf(node);
    const body = branches.find((branch) => branch.key === 'try');
    const handler = branches.find((branch) => branch.key === 'catch');
    const final = branches.find((branch) => branch.always === true);
    const chosen = forcedSide(node, enabled) ?? decisions[key];
    let flow: Flow;
    if (chosen === 'catch' && handler !== undefined) {
      resolved[key] = 'catch';
      failure = undefined;
      push(frame, node, step, { event: 'catches', side: { key: 'catch', label: handler.label, assumed: false } });
      flow = list(handler.nodes, frame, step);
    } else {
      flow = list(body?.nodes ?? [], frame, step);
      if (flow === 'fails' && handler !== undefined && !cut) {
        if (chosen !== undefined) resolved[key] = chosen;
        const error = failure;
        push(frame, node, step, { event: 'catches', side: { key: 'catch', label: handler.label, assumed: false }, ...(error === undefined ? {} : { error }) });
        flow = list(handler.nodes, frame, step);
      } else if (flow !== 'fails' && handler !== undefined) {
        // No exception: the catch does not run, chosen or assumed.
        resolved[key] = 'try';
        if (chosen !== 'try') assumed.push(key);
      }
    }
    if (final === undefined || cut) return flow;
    // A finally runs whichever way its try came out, and what it does itself wins.
    const pending = failure;
    const after = list(final.nodes, frame, step);
    if (after !== 'goes') return after;
    failure = pending;
    return flow;
  };

  /** A decision: the side the features force, the choice names or the walk assumes, and the nodes of that side. */
  const decide = (node: TreeNode, frame: Frame, step: string | undefined, key: string): Flow => {
    const branches = sidesOf(node);
    const sides = branches.filter((branch) => branch.always !== true);
    const forced = forcedSide(node, enabled);
    const named = forced ?? decisions[key];
    const chosen = named === undefined ? undefined : sides.find((branch) => branch.key === named);
    const taken = chosen ?? assumedSide(node, sides);
    if (taken === undefined) {
      push(frame, node, step);
      return 'goes';
    }
    const isAssumed = chosen === undefined;
    if (forced === undefined) {
      resolved[key] = taken.key;
      if (isAssumed) assumed.push(key);
    }
    push(frame, node, step, { side: { key: taken.key, label: taken.label, assumed: isAssumed } });
    // A case that runs on into the next one runs that one too.
    let at = sides.indexOf(taken);
    let flow = list(taken.nodes, frame, step);
    while (flow === 'goes' && sides[at]?.fallsThrough === true && sides[at + 1] !== undefined) {
      at += 1;
      flow = list((sides[at] as Branch).nodes, frame, step);
    }
    return flow;
  };

  const root: Frame = { key: options.frame ?? '', tree, depth: 0, chain: [tree.id] };
  const flow = list(tree.nodes, root, undefined);
  const fails = flow === 'fails';
  return {
    stops,
    outcome: fails ? 'fails' : 'returns',
    ...(fails && failure !== undefined ? { error: failure } : {}),
    resolved,
    assumed,
    ...(cut ? { cut: true as const } : {}),
  };
}

/** The steps of the starting frame a walk runs, each once, in the order it first reaches them. */
export function stepsOf(walked: Pick<FlowWalk, 'stops'>): string[] {
  const steps: string[] = [];
  for (const stop of walked.stops) {
    if (stop.depth === 0 && stop.step !== undefined && !steps.includes(stop.step)) steps.push(stop.step);
  }
  return steps;
}
