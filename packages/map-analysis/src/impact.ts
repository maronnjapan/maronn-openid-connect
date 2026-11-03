/**
 * Where a change takes effect: the ways from the endpoints to it, computed
 * from the call nodes of the trees (whose callees the types resolved), not
 * written by hand.
 *
 * A way names the frames to open from the root of the endpoint (the chain of
 * call nodes), the sides of the decisions that lead along it in every frame,
 * and the features it needs on. A change of the implementation of a member of
 * an interface (a method of a store that `createProviderStores` returns)
 * reaches every call of that member.
 */
import type { Decisions, FlowEndpoint, FlowTree, Reach, TreeNode } from './model.js';
import { inFrame, wayTo } from './selections.js';
import { nodesOf } from './tree.js';

export interface EndpointRoot {
  /** The source the endpoint is generated from (hono, nextjs) and its frameworks. */
  source: string;
  frameworks: string[];
  endpoint: Pick<FlowEndpoint, 'id' | 'feature'>;
  /** The frame its trace starts from. */
  root: string;
}

/** The call nodes of every frame, and the callers of every callee. */
export class CallGraph {
  readonly sites = new Map<string, Array<[string, string]>>();
  readonly callers = new Map<string, Set<string>>();

  constructor(
    readonly trees: ReadonlyMap<string, FlowTree>,
    readonly endpoints: readonly EndpointRoot[],
  ) {
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
    }
  }

  /** The frames that reach any of some frames or members (themselves included). */
  upstream(targets: readonly string[]): Set<string> {
    const found = new Set<string>(targets);
    const pending = [...targets];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      for (const caller of this.callers.get(id) ?? []) {
        if (found.has(caller)) continue;
        found.add(caller);
        pending.push(caller);
      }
    }
    return found;
  }

  /** The shortest chain of call nodes from a frame to one of the targets: [frame, call node] each, the last call node calling a target. */
  path(from: string, targets: ReadonlySet<string>, within: ReadonlySet<string>): Array<[string, string]> | undefined {
    const previous = new Map<string, [string, string] | null>([[from, null]]);
    const queue = [from];
    for (let index = 0; index < queue.length; index += 1) {
      const frame = queue[index] as string;
      for (const [node, callee] of this.sites.get(frame) ?? []) {
        if (targets.has(callee)) {
          const chain: Array<[string, string]> = [[frame, node]];
          for (let step = previous.get(frame); step !== null && step !== undefined; step = previous.get(step[0])) chain.unshift(step);
          return chain;
        }
        if (!within.has(callee) || previous.has(callee) || !this.trees.has(callee)) continue;
        previous.set(callee, [frame, node]);
        queue.push(callee);
      }
    }
    return undefined;
  }
}

/** The node of a tree with an id. */
function nodeOf(tree: FlowTree, id: string): TreeNode | undefined {
  for (const node of nodesOf(tree.nodes)) if (node.id === id) return node;
  return undefined;
}

/** The features of the blocks a node of a tree is inside of. */
function featuresAround(tree: FlowTree, id: string): string[] {
  const features: string[] = [];
  const visit = (nodes: readonly TreeNode[]): boolean => {
    for (const node of nodes) {
      const inside = node.id === id || (id.startsWith(node.id) && [...nodesOf([node])].some((child) => child.id === id));
      if (!inside) continue;
      if (node.feature !== undefined) features.push(node.feature);
      if (node.id === id) return true;
      if (node.pre !== undefined && visit(node.pre)) return true;
      for (const branch of node.branches ?? []) if (visit(branch.nodes)) return true;
      return false;
    }
    return false;
  };
  visit(tree.nodes);
  return features;
}

/** The step a node of a tree is in: the block around it, or the step its call is. */
function stepAround(tree: FlowTree, id: string): string | undefined {
  let step: string | undefined;
  const visit = (nodes: readonly TreeNode[]): boolean => {
    for (const node of nodes) {
      const inside = node.id === id || (id.startsWith(node.id) && [...nodesOf([node])].some((child) => child.id === id));
      if (!inside) continue;
      if (node.step !== undefined) step = node.step.id;
      if (node.id === id) return true;
      if (node.pre !== undefined && visit(node.pre)) return true;
      for (const branch of node.branches ?? []) if (visit(branch.nodes)) return true;
      return false;
    }
    return false;
  };
  visit(tree.nodes);
  return step;
}

/** What a way leads to: a node of a changed frame, or the calls of a changed member. */
export type ReachTarget = { frame: string; node: string } | { member: string };

/**
 * The ways from the endpoints to a target (see the module comment): for
 * each endpoint, one way through each step that leads to it.
 */
export function reachOf(graph: CallGraph, target: ReachTarget): Reach[] {
  const ends = 'frame' in target ? new Set([target.frame]) : new Set([target.member]);
  const within = graph.upstream([...ends]);
  const ways: Reach[] = [];
  for (const entry of graph.endpoints) {
    const root = graph.trees.get(entry.root);
    if (root === undefined || !within.has(entry.root)) continue;
    const base = { source: entry.source, frameworks: entry.frameworks, endpoint: entry.endpoint.id };
    const endpointFeatures = entry.endpoint.feature === undefined ? [] : [entry.endpoint.feature];
    if ('frame' in target && target.frame === entry.root) {
      const way = wayTo(root.nodes, target.node);
      ways.push({ ...base, frames: [], decisions: way?.decisions ?? {}, via: [], features: [...new Set([...endpointFeatures, ...featuresAround(root, target.node)])], target: target.node, ...(stepAround(root, target.node) === undefined ? {} : { step: stepAround(root, target.node) as string }) });
      continue;
    }
    const seenSteps = new Set<string>();
    for (const [node, callee] of graph.sites.get(entry.root) ?? []) {
      if (!ends.has(callee) && !within.has(callee)) continue;
      const step = stepAround(root, node) ?? '';
      if (seenSteps.has(step)) continue;
      const chain: Array<[string, string]> = [[entry.root, node]];
      if (!ends.has(callee)) {
        const rest = graph.path(callee, ends, within);
        if (rest === undefined) continue;
        chain.push(...rest);
      }
      seenSteps.add(step);
      // The keys of the frames each call node opens, and the decisions along the way in each frame.
      const frames: string[] = [];
      const decisions: Decisions = {};
      const features = new Set<string>(endpointFeatures);
      const via: string[] = [];
      let key = '';
      for (const [frame, call] of chain) {
        const tree = graph.trees.get(frame) as FlowTree;
        Object.assign(decisions, inFrame(wayTo(tree.nodes, call)?.decisions ?? {}, key));
        for (const feature of featuresAround(tree, call)) features.add(feature);
        key = key === '' ? call : `${key}.${call}`;
        frames.push(key);
        const opened = nodeOf(tree, call)?.target;
        if (opened !== undefined && opened.kind === 'function') via.push(opened.id);
      }
      let leads = key;
      if ('frame' in target) {
        const changed = graph.trees.get(target.frame);
        if (changed !== undefined) Object.assign(decisions, inFrame(wayTo(changed.nodes, target.node)?.decisions ?? {}, key));
        leads = target.node === '' ? key : `${key}.${target.node}`;
      } else {
        // A member: the way ends at the call of it, which opens no frame.
        frames.pop();
      }
      ways.push({ ...base, ...(step === '' ? {} : { step }), frames, decisions, via, features: [...features], target: leads });
    }
  }
  return ways;
}
