/**
 * Where a change takes effect: the ways from the endpoints to it, computed
 * from the call nodes of the trees (whose callees the types resolved), not
 * written by hand.
 *
 * A way names the frames to open from the root of the endpoint (the chain of
 * call nodes), the sides of the decisions that lead along it in every frame,
 * and the features it needs on.
 *
 * The members of interfaces join the calls: a member is called by the call
 * nodes that call it, and calls what its implementations call
 * (FlowTree.implements). So a change of the implementation of a member (a
 * method of a store that `createProviderStores` returns) reaches every call
 * of that member, and a change below an implementation (the store a
 * resolver's method reads) reaches every call of the resolver's member. An
 * implementation in the code of an app (hono, nextjs) runs under the
 * endpoints generated from that app only; one in a library (core,
 * experimental, google-login) under every source. A way that goes through a
 * member stops at the call of the member (an implementation has no frame to
 * open) and names the members below it (Reach.through).
 */
import type { Decisions, FlowEndpoint, FlowTree, Reach, TreeNode } from './model.js';
import { inFrame, wayTo } from './selections.js';
import { nodesOf } from './tree.js';

/** An endpoint of a source, with the frame its trace starts from. */
export interface EndpointRoot {
  /** The source the endpoint is generated from (hono, nextjs) and its frameworks. */
  source: string;
  frameworks: string[];
  endpoint: Pick<FlowEndpoint, 'id' | 'feature'>;
  /** The frame its trace starts from. */
  root: string;
}

/** The root of the catalog an id is in (`hono` of `hono:oidc-provider/…#f`). */
export function rootOf(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf(':')));
}

/** A call an implementation of a member makes: what it calls, and the frame and root the implementation is in. */
export interface MemberCall {
  callee: string;
  by: string;
  root: string;
}

/** The call nodes of every frame, the calls of the implementations of every member, and the callers of every callee. */
export class CallGraph {
  /** The call nodes of each frame: [node id, callee]. */
  readonly sites = new Map<string, Array<[string, string]>>();
  /** The frames whose call nodes call each callee. */
  readonly callers = new Map<string, Set<string>>();
  /** What the implementations of each member call. */
  readonly memberCalls = new Map<string, MemberCall[]>();
  /** The members whose implementations call each callee, with the root of each implementation. */
  private readonly implementers = new Map<string, Array<{ member: string; root: string }>>();
  /** The sources of the endpoints: the roots whose code runs under their own endpoints only. */
  private readonly sources: ReadonlySet<string>;

  constructor(
    readonly trees: ReadonlyMap<string, FlowTree>,
    readonly endpoints: readonly EndpointRoot[],
  ) {
    this.sources = new Set(endpoints.map((entry) => entry.source));
    for (const [id, tree] of trees) {
      const list: Array<[string, string]> = [];
      for (const node of nodesOf(tree.nodes)) {
        if (node.kind !== 'call' || node.target === undefined || node.target.kind === 'untraceable') continue;
        list.push([node.id, node.target.id]);
        const set = this.callers.get(node.target.id) ?? new Set<string>();
        set.add(id);
        this.callers.set(node.target.id, set);
      }
      this.sites.set(id, list);
      for (const implementation of tree.implements ?? []) {
        for (const callee of implementation.calls ?? []) {
          const call: MemberCall = { callee, by: id, root: rootOf(id) };
          this.memberCalls.set(implementation.member, [...(this.memberCalls.get(implementation.member) ?? []), call]);
          this.implementers.set(callee, [...(this.implementers.get(callee) ?? []), { member: implementation.member, root: call.root }]);
        }
      }
    }
  }

  /** Whether the code of a root runs under the endpoints of a source: an app's under its own, a library's under every one (every source when none is given). */
  serves(root: string, source: string | undefined): boolean {
    return source === undefined || !this.sources.has(root) || root === source;
  }

  /** What calls a frame or a member: the frames whose call nodes call it, and the members whose implementations (that run under the source) call it. */
  private callersOf(id: string, source: string | undefined): string[] {
    const members = (this.implementers.get(id) ?? []).filter((entry) => this.serves(entry.root, source)).map((entry) => entry.member);
    return [...(this.callers.get(id) ?? []), ...members];
  }

  /** The frames and members that reach any of some frames or members (themselves included), under the endpoints of a source. */
  upstream(targets: readonly string[], source?: string): Set<string> {
    const found = new Set<string>(targets);
    const pending = [...targets];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      for (const caller of this.callersOf(id, source)) {
        if (found.has(caller)) continue;
        found.add(caller);
        pending.push(caller);
      }
    }
    return found;
  }

  /**
   * The shortest chain of call nodes from a frame to one of the targets:
   * [frame, call node] each, the last call node calling a target. Without
   * one through frames only, the shortest chain to the call of a member that
   * leads to a target (`member`): the way stops there.
   */
  path(from: string, targets: ReadonlySet<string>, within: ReadonlySet<string>): { chain: Array<[string, string]>; member?: string } | undefined {
    const previous = new Map<string, [string, string] | null>([[from, null]]);
    const chainTo = (frame: string, node: string) => {
      const chain: Array<[string, string]> = [[frame, node]];
      for (let step = previous.get(frame); step !== null && step !== undefined; step = previous.get(step[0])) chain.unshift(step);
      return chain;
    };
    let viaMember: { chain: Array<[string, string]>; member: string } | undefined;
    const queue = [from];
    for (let index = 0; index < queue.length; index += 1) {
      const frame = queue[index] as string;
      for (const [node, callee] of this.sites.get(frame) ?? []) {
        if (targets.has(callee)) return { chain: chainTo(frame, node) };
        if (!within.has(callee) || previous.has(callee)) continue;
        if (!this.trees.has(callee)) {
          if (this.memberCalls.has(callee)) viaMember ??= { chain: chainTo(frame, node), member: callee };
          continue;
        }
        previous.set(callee, [frame, node]);
        queue.push(callee);
      }
    }
    return viaMember;
  }

  /**
   * The members from a member down to a target, the member first (and the
   * target last when it is a member): through the calls of the
   * implementations that run under the source, and the call nodes of the
   * frames between.
   */
  down(member: string, targets: ReadonlySet<string>, within: ReadonlySet<string>, source: string | undefined): string[] {
    const previous = new Map<string, string | null>([[member, null]]);
    const queue = [member];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index] as string;
      if (targets.has(id) && id !== member) {
        const chain: string[] = [];
        for (let step: string | null | undefined = id; step !== null && step !== undefined; step = previous.get(step)) chain.unshift(step);
        return chain.filter((entry) => this.memberCalls.has(entry) || (targets.has(entry) && !this.trees.has(entry)));
      }
      const next = [...(this.memberCalls.get(id) ?? []).filter((call) => this.serves(call.root, source)).map((call) => call.callee), ...(this.sites.get(id) ?? []).map(([, callee]) => callee)];
      for (const callee of next) {
        if (previous.has(callee) || (!within.has(callee) && !targets.has(callee))) continue;
        previous.set(callee, id);
        queue.push(callee);
      }
    }
    return [member];
  }
}

/** The node of a tree with an id. */
function nodeOf(tree: FlowTree, id: string): TreeNode | undefined {
  for (const node of nodesOf(tree.nodes)) if (node.id === id) return node;
  return undefined;
}

/** Whether a node or one below it has an id. */
function contains(node: TreeNode, id: string): boolean {
  if (node.id === id) return true;
  if (!id.startsWith(node.id)) return false;
  return (node.pre ?? []).some((child) => contains(child, id)) || (node.branches ?? []).some((branch) => branch.nodes.some((child) => contains(child, id)));
}

/** The nodes a node of a tree is inside of, the outermost first, the node itself last (empty when the tree has none). */
function around(tree: FlowTree, id: string): TreeNode[] {
  const chain: TreeNode[] = [];
  const visit = (nodes: readonly TreeNode[]): boolean => {
    for (const node of nodes) {
      if (!contains(node, id)) continue;
      chain.push(node);
      if (node.id === id) return true;
      if (node.pre !== undefined && visit(node.pre)) return true;
      for (const branch of node.branches ?? []) if (visit(branch.nodes)) return true;
      return false;
    }
    return false;
  };
  visit(tree.nodes);
  return chain;
}

/** The features of the blocks a node of a tree is inside of. */
function featuresAround(tree: FlowTree, id: string): string[] {
  return around(tree, id).flatMap((node) => (node.feature === undefined ? [] : [node.feature]));
}

/** The step a node of a tree is in: the block around it, or the step its call is. */
function stepAround(tree: FlowTree, id: string): string | undefined {
  return around(tree, id).reduce<string | undefined>((step, node) => node.step?.id ?? step, undefined);
}

/** Whether a `try` catches what fails in its try side: it has a catch that does not throw again what it caught. */
function catches(node: TreeNode): boolean {
  const handler = node.branches?.find((branch) => branch.key === 'catch');
  return handler !== undefined && ![...nodesOf(handler.nodes)].some((child) => child.kind === 'throw' && child.rethrow === true);
}

/** The innermost `try` of a tree whose try side holds a node and that catches (see catches). */
export function catcherIn(tree: FlowTree, id: string): TreeNode | undefined {
  const chain = around(tree, id);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const node = chain[index] as TreeNode;
    const inner = chain[index + 1] as TreeNode;
    if (node.kind === 'try' && catches(node) && (node.branches?.find((branch) => branch.key === 'try')?.nodes ?? []).some((child) => contains(child, inner.id))) return node;
  }
  return undefined;
}

/** What a way leads to: a node of a changed frame, or the calls of a member whose implementation changed in a root. */
export type ReachTarget = { frame: string; node: string } | { member: string; root?: string };

/** What reachOf computes besides the ways. */
export interface ReachOptions {
  /** Find where a failure the change makes leave its frame is caught on each way (Reach.caught, Reach.escapes). */
  failures?: boolean;
}

/**
 * The ways from the endpoints to a target (see the module comment): for
 * each endpoint that the target's code runs under, one way through each
 * step that leads to it.
 */
export function reachOf(graph: CallGraph, target: ReachTarget, options: ReachOptions = {}): Reach[] {
  const ends = 'frame' in target ? new Set([target.frame]) : new Set([target.member]);
  const root = 'frame' in target ? rootOf(target.frame) : target.root;
  const withinOf = new Map<string, Set<string>>();
  const ways: Reach[] = [];
  for (const entry of graph.endpoints) {
    if (root !== undefined && !graph.serves(root, entry.source)) continue;
    const tree = graph.trees.get(entry.root);
    if (tree === undefined) continue;
    const within = withinOf.get(entry.source) ?? graph.upstream([...ends], entry.source);
    withinOf.set(entry.source, within);
    if (!within.has(entry.root)) continue;
    const base = { source: entry.source, frameworks: entry.frameworks, endpoint: entry.endpoint.id };
    const endpointFeatures = entry.endpoint.feature === undefined ? [] : [entry.endpoint.feature];
    if ('frame' in target && target.frame === entry.root) {
      const way = wayTo(tree.nodes, target.node);
      const step = stepAround(tree, target.node);
      // A failure that leaves the root frame leaves the endpoint.
      ways.push({ ...base, frames: [], decisions: way?.decisions ?? {}, via: [], features: [...new Set([...endpointFeatures, ...featuresAround(tree, target.node)])], target: target.node, ...(step === undefined ? {} : { step }), ...(options.failures === true ? { escapes: true as const } : {}) });
      continue;
    }
    const seenSteps = new Set<string>();
    for (const [node, callee] of graph.sites.get(entry.root) ?? []) {
      if (!ends.has(callee) && !within.has(callee)) continue;
      const step = stepAround(tree, node) ?? '';
      if (seenSteps.has(step)) continue;
      const chain: Array<[string, string]> = [[entry.root, node]];
      let member: string | undefined;
      if (!ends.has(callee)) {
        if (graph.trees.has(callee)) {
          const rest = graph.path(callee, ends, within);
          if (rest === undefined) continue;
          chain.push(...rest.chain);
          member = rest.member;
        } else if (graph.memberCalls.has(callee)) {
          member = callee;
        } else continue;
      }
      seenSteps.add(step);
      // The keys of the frames each call node opens, and the decisions along the way in each frame.
      const frames: string[] = [];
      const decisions: Decisions = {};
      const features = new Set<string>(endpointFeatures);
      const via: string[] = [];
      let key = '';
      for (const [frame, call] of chain) {
        const inside = graph.trees.get(frame) as FlowTree;
        Object.assign(decisions, inFrame(wayTo(inside.nodes, call)?.decisions ?? {}, key));
        for (const feature of featuresAround(inside, call)) features.add(feature);
        key = key === '' ? call : `${key}.${call}`;
        frames.push(key);
        const opened = nodeOf(inside, call)?.target;
        if (opened !== undefined && opened.kind === 'function') via.push(opened.id);
      }
      let leads = key;
      const way: Reach = { ...base, ...(step === '' ? {} : { step }), frames, decisions, via, features: [], target: '' };
      if ('frame' in target && member === undefined) {
        const changed = graph.trees.get(target.frame);
        if (changed !== undefined) Object.assign(decisions, inFrame(wayTo(changed.nodes, target.node)?.decisions ?? {}, key));
        leads = target.node === '' ? key : `${key}.${target.node}`;
      } else {
        // The way ends at the call of a member, which opens no frame.
        frames.pop();
        if (member !== undefined) way.through = graph.down(member, ends, within, entry.source);
      }
      way.features = [...features];
      way.target = leads;
      if (options.failures === true) {
        // The failure comes up the chain from its last call: the innermost frame on the way whose try catches it.
        let caught: Reach['caught'];
        for (let index = chain.length - 1; index >= 0 && caught === undefined; index -= 1) {
          const [frame, call] = chain[index] as [string, string];
          const inside = graph.trees.get(frame) as FlowTree;
          const handler = catcherIn(inside, call);
          if (handler === undefined) continue;
          const first = [...nodesOf(handler.branches?.find((branch) => branch.key === 'catch')?.nodes ?? [])].find((child) => child.kind === 'call' && child.target !== undefined && child.target.kind !== 'untraceable');
          const called = first?.target?.kind === 'untraceable' ? undefined : first?.target?.id;
          caught = { frame, name: inside.name, node: handler.id, ...(called === undefined ? {} : { call: `${called.slice(called.indexOf('#') + 1)}(…)` }) };
        }
        if (caught !== undefined) way.caught = caught;
        else way.escapes = true;
      }
      ways.push(way);
    }
  }
  return ways;
}
