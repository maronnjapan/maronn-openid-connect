/**
 * The diagram of one frame: its tree flattened into boxes and arrows, for the
 * reader who wants to see the shape of the flow. The outline of the trace is
 * the main view; the diagram shows the frame it focuses on, with the way the
 * choices take in blue. Nothing here touches the DOM.
 */
import type { Decisions, FlowTree, TreeNode } from '../types';
import type { GraphEdge, GraphNode } from './graph';
import { branchesOf, chosenSide, decisionKey, forcedSide, nodesOn, nodesRun } from './trace';

export interface DiagramNode extends GraphNode {
  /** The first line of the box. */
  title: string;
  /** The second line: what the box does. */
  subtitle: string;
  tone: 'normal' | 'start' | 'end' | 'error';
  /** The node of the tree the box is (absent for the start). */
  node?: string;
  /** What the box opens. */
  target?: { fn: string } | { member: string } | { step: string };
}

export interface Diagram {
  /** Names the diagram (its frame), so the view resets when it changes. */
  key: string;
  nodes: DiagramNode[];
  edges: GraphEdge[];
  /** For an arrow out of a decision: the decision and its side, by the index of the arrow. */
  sides: Map<number, { node: string; side: string }>;
}

interface Pending {
  from: string;
  label?: string;
  kind: GraphEdge['kind'];
  side?: { node: string; side: string };
}

/** The diagram of a frame (see the module comment); `enabled` narrows it to the features that are on. */
export function frameDiagram(tree: FlowTree, frame: string, enabled?: ReadonlySet<string>): Diagram {
  const nodes: DiagramNode[] = [];
  const edges: GraphEdge[] = [];
  const sides = new Map<number, { node: string; side: string }>();
  const connect = (entries: readonly Pending[], to: string) => {
    for (const entry of entries) {
      const edge: GraphEdge = { from: entry.from, to, kind: entry.kind };
      if (entry.label !== undefined) edge.label = entry.label;
      if (entry.side !== undefined) sides.set(edges.length, entry.side);
      edges.push(edge);
    }
  };
  const box = (node: TreeNode, entries: readonly Pending[], override?: Partial<DiagramNode>): string => {
    const id = `n:${node.id}`;
    const diagramNode: DiagramNode = {
      id,
      node: node.id,
      title: node.kind === 'block' ? (node.step?.label ?? node.code) : node.code,
      subtitle: node.kind === 'block' ? `[${node.step?.id ?? ''}]` : (node.text ?? ''),
      tone: node.kind === 'throw' ? 'error' : node.kind === 'return' || node.kind === 'end' ? 'end' : 'normal',
      ...override,
    };
    if (node.kind === 'call' && node.target?.kind === 'function') diagramNode.target = { fn: node.target.id };
    if (node.kind === 'call' && node.target?.kind === 'member') diagramNode.target = { member: node.target.id };
    if (node.kind === 'block' && node.step !== undefined) diagramNode.target = { step: node.step.id };
    nodes.push(diagramNode);
    connect(entries, id);
    return id;
  };
  const list = (items: readonly TreeNode[], entries: Pending[]): Pending[] => {
    let open = entries;
    const visible = nodesOn(items, enabled);
    for (let index = 0; index < visible.length; index += 1) {
      const node = visible[index] as TreeNode;
      for (const before of node.pre ?? []) open = one(before, open);
      // A run of actions is one box.
      if (node.kind === 'action') {
        let end = index;
        while (end + 1 < visible.length && (visible[end + 1] as TreeNode).kind === 'action') end += 1;
        if (end > index) {
          const id = box(node, open, { title: `処理 ×${end - index + 1}`, subtitle: visible.slice(index, end + 1).map((item) => item.code).join(' / ') });
          open = [{ from: id, kind: 'flow' }];
          index = end;
          continue;
        }
      }
      open = one(node, open);
    }
    return open;
  };
  const one = (node: TreeNode, entries: Pending[]): Pending[] => {
    switch (node.kind) {
      case 'return':
      case 'throw': {
        const id = box(node, entries);
        return node.local === true ? [{ from: id, kind: 'flow' }] : [];
      }
      case 'block': {
        const id = box(node, entries);
        return list(node.branches?.[0]?.nodes ?? [], [{ from: id, kind: 'flow' }]);
      }
      case 'try': {
        const id = box(node, entries, { title: 'try', subtitle: '例外を捕まえる範囲' });
        const branches = node.branches ?? [];
        const attempt = branches.find((branch) => branch.key === 'try');
        const handler = branches.find((branch) => branch.key === 'catch');
        const final = branches.find((branch) => branch.key === 'finally');
        let out = list(attempt?.nodes ?? [], [{ from: id, kind: 'flow' }]);
        if (handler !== undefined) out = [...out, ...list(handler.nodes, [{ from: id, kind: 'error', label: '例外が起きたとき', side: { node: node.id, side: 'catch' } }])];
        if (final !== undefined) out = list(final.nodes, out);
        return out;
      }
      case 'loop': {
        const id = box(node, entries);
        const body = node.branches?.find((branch) => branch.key === 'body');
        const out = list(body?.nodes ?? [], [{ from: id, kind: 'branch', label: body?.label ?? '繰り返す', side: { node: node.id, side: 'body' } }]);
        const skip = node.branches?.find((branch) => branch.key === 'skip');
        return [...out, ...(skip === undefined ? [] : [{ from: id, kind: 'branch' as const, label: skip.label, side: { node: node.id, side: 'skip' } }])];
      }
      case 'if':
      case 'switch':
      case 'cond-expr': {
        const id = box(node, entries);
        const out: Pending[] = [];
        for (const branch of branchesOf(node, enabled)) {
          const entry: Pending = { from: id, kind: 'branch', label: branch.label, side: { node: node.id, side: branch.key } };
          out.push(...(branch.nodes.length === 0 ? [entry] : list(branch.nodes, [entry])));
        }
        return out;
      }
      default: {
        const id = box(node, entries);
        return [{ from: id, kind: 'flow' }];
      }
    }
  };
  nodes.push({ id: 'start', title: tree.signature || tree.name, subtitle: '', tone: 'start' });
  list(tree.nodes, [{ from: 'start', kind: 'flow' }]);
  return { key: `frame:${tree.id}:${frame}`, nodes, edges, sides };
}

/** The boxes and arrows the choices run through: a box whose node runs, an arrow between two such boxes on the chosen side. */
export function activeOf(diagram: Diagram, tree: FlowTree, frame: string, choices: readonly Decisions[], enabled?: ReadonlySet<string>): { nodes: Set<string>; edges: Set<number> } {
  const run = nodesRun(tree, frame, choices, enabled);
  const nodes = new Set<string>(['start']);
  for (const node of diagram.nodes) if (node.node !== undefined && run.has(node.node)) nodes.add(node.id);
  const edges = new Set<number>();
  diagram.edges.forEach((edge, index) => {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
    const side = diagram.sides.get(index);
    if (side !== undefined) {
      const decision = diagram.nodes.find((node) => node.node === side.node);
      const treeNode = decision === undefined ? undefined : findIn(tree.nodes, side.node);
      const chosen = (treeNode === undefined ? undefined : forcedSide(treeNode, enabled)) ?? chosenSide(choices, decisionKey(frame, side.node));
      if (chosen !== undefined && chosen !== side.side) return;
    }
    edges.add(index);
  });
  return { nodes, edges };
}

function findIn(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (!id.startsWith(node.id)) continue;
    const found = findIn(node.pre ?? [], id) ?? (node.branches ?? []).reduce<TreeNode | undefined>((hit, branch) => hit ?? findIn(branch.nodes, id), undefined);
    if (found !== undefined) return found;
  }
  return undefined;
}
