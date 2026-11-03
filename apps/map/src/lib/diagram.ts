/**
 * An endpoint and a function as the same kind of diagram (graph.ts): the
 * boxes with the two lines they show, the arrows, and the cases. The text of
 * a box says what happens there: the label of a step, or what the function a
 * box calls does (the comment the author wrote above the line, else the first
 * line of the callee's JSDoc).
 */
import type { FlowEndpoint, FunctionCard, MapData } from '../types';
import { deriveCases, type FlowCase, type GraphEdge, type GraphNode } from './graph';
import { featureOf } from './model';

export interface DiagramNode extends GraphNode {
  /** The first line of the box. */
  title: string;
  /** The second line: what the box does. */
  subtitle: string;
  /** normal, the start of a function, where it ends, or the error step / a throw. */
  tone: 'normal' | 'start' | 'end' | 'error';
  /** What the box opens: a step of the endpoint, a function, or the member of an interface. */
  target?: { step: string } | { fn: string } | { member: string };
}

export interface Diagram {
  /** Names the diagram, for the cases a reader checked on it. */
  key: string;
  nodes: DiagramNode[];
  edges: GraphEdge[];
  cases: FlowCase[];
}

/** The words of an arrow of a function, as the page says them. */
function edgeText(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  return label
    .replace(/^else if /, 'それ以外で ')
    .replace(/^else$/, 'それ以外')
    .replace(/ › else$/, ' › それ以外')
    .replace(/^catch$/, '例外が起きたとき')
    .replace(/^true$/, '成立')
    .replace(/^false$/, '不成立')
    .replace(/^nullish$/, 'null または undefined')
    .replace(/^defined$/, 'null・undefined 以外')
    .replace(/^catch › /, '例外が起きたとき › ');
}

/** The steps of an endpoint and their arrows. */
export function endpointDiagram(endpoint: FlowEndpoint, data: MapData): Diagram {
  if (endpoint.controlFlow !== undefined) {
    const card: FunctionCard = { id: endpoint.id, name: endpoint.label, package: '', module: '', line: 1, exported: false, kind: 'other', summary: endpoint.label, calls: [], calledBy: [], flow: endpoint.controlFlow };
    const diagram = functionDiagram(card, data) as Diagram;
    const byId = new Map(endpoint.controlFlow.nodes.map((node) => [node.id, node]));
    const nodes = diagram.nodes.map((node) => {
      const step = endpoint.steps.find((step) => step.id === byId.get(node.id)?.step);
      return step === undefined ? node : { ...node, title: step.label, subtitle: `${step.function}()`, target: { step: step.id } };
    });
    return finishEndpoint(endpoint.id, nodes, diagram.edges);
  }
  const errorSteps = new Set(endpoint.edges.filter((edge) => edge.kind === 'error').map((edge) => edge.to));
  const nodes: DiagramNode[] = endpoint.steps.map((step) => {
    const feature = step.feature === undefined ? '' : `（${featureOf(data.features, step.feature)?.id ?? step.feature}）`;
    return {
      id: step.id,
      title: `${step.label}${feature}`,
      // A step of Next.js is a block of the Route Handler, marked by its id; the others are a function.
      subtitle: step.functionId === undefined && step.module !== undefined ? `[${step.id}] ${step.module}` : `${step.function}()`,
      tone: errorSteps.has(step.id) ? 'error' : 'normal',
      target: { step: step.id },
    };
  });
  const edges: GraphEdge[] = endpoint.edges.map((edge) => ({ ...edge }));
  const label = (id: string) => endpoint.steps.find((step) => step.id === id)?.label ?? id;
  // Even metadata-only endpoints keep a distinct error response per source.
  const separate = separateErrors(nodes, edges);
  return { key: `endpoint:${endpoint.id}`, ...separate, cases: deriveCases(separate.nodes, separate.edges, { errors: 'modifier', nodeLabel: label, nameBySink: false }) };
}

/** Keep each failed step's response separate, including the conditions inside its catch handler. */
function separateErrors(nodes: DiagramNode[], edges: GraphEdge[]): { nodes: DiagramNode[]; edges: GraphEdge[] } {
  const incoming = new Set(edges.map((edge) => edge.to));
  const normal = new Set(nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id));
  const queue = [...normal];
  while (queue.length > 0) {
    const from = queue.pop();
    for (const edge of edges) if (edge.from === from && edge.kind !== 'error' && !normal.has(edge.to)) {
      normal.add(edge.to);
      queue.push(edge.to);
    }
  }
  const exclusive = new Set<string>();
  const copies: DiagramNode[] = [];
  const copiedEdges: GraphEdge[] = [];
  edges.forEach((error, index) => {
    if (error.kind !== 'error' || !normal.has(error.from) || normal.has(error.to)) return;
    const region = new Set<string>();
    const visit = (id: string) => {
      if (normal.has(id) || region.has(id)) return;
      region.add(id);
      for (const edge of edges) if (edge.from === id) visit(edge.to);
    };
    visit(error.to);
    const rename = (id: string) => region.has(id) ? `${id}:error:${index}` : id;
    const source = nodes.find((node) => node.id === error.from)?.title ?? error.from;
    for (const node of nodes) if (region.has(node.id)) {
      exclusive.add(node.id);
      copies.push({ ...node, id: rename(node.id), tone: 'error', subtitle: `${source} でのエラー · ${node.subtitle}` });
    }
    copiedEdges.push({ ...error, to: rename(error.to) });
    for (const edge of edges) if (region.has(edge.from)) copiedEdges.push({ ...edge, from: rename(edge.from), to: rename(edge.to) });
  });
  // Only remove handlers that were actually copied; unrelated error paths stay intact.
  return {
    nodes: [...nodes.filter((node) => !exclusive.has(node.id)), ...copies],
    edges: [...edges.filter((edge) => !exclusive.has(edge.from) && !exclusive.has(edge.to)), ...copiedEdges],
  };
}

/** Derive endpoint cases from implementation branches and their separate error responses. */
function finishEndpoint(id: string, nodes: DiagramNode[], edges: GraphEdge[]): Diagram {
  const separate = separateErrors(nodes, edges);
  const label = (id: string) => {
    const node = separate.nodes.find((node) => node.id === id);
    return node?.tone === 'error' ? `${node.title}（${node.subtitle}）` : node?.title ?? id;
  };
  return { key: `endpoint:${id}`, ...separate, cases: deriveCases(separate.nodes, separate.edges, { errors: 'path', nodeLabel: label, nameBySink: true }) };
}

/** The flow inside a function; undefined for a function without one. */
export function functionDiagram(card: FunctionCard, data: MapData): Diagram | undefined {
  const flow = card.flow;
  if (flow === undefined) return undefined;
  const nodes: DiagramNode[] = flow.nodes.map((node) => {
    switch (node.kind) {
      case 'start':
        return { id: node.id, title: node.label, subtitle: card.summary, tone: 'start' };
      case 'condition':
        return { id: node.id, title: node.label, subtitle: '条件によって処理を分ける', tone: 'normal' };
      case 'call': {
        const callee = node.callee === undefined ? undefined : data.functions[node.callee];
        const diagramNode: DiagramNode = { id: node.id, title: `${node.label}()`, subtitle: node.note ?? callee?.summary ?? '', tone: 'normal' };
        if (node.callee !== undefined) diagramNode.target = { fn: node.callee };
        return diagramNode;
      }
      case 'dynamic': {
        const member = node.member === undefined ? undefined : data.members[node.member];
        const diagramNode: DiagramNode = { id: node.id, title: `${node.label}()`, subtitle: node.note ?? member?.summary ?? '', tone: 'normal' };
        if (node.member !== undefined) diagramNode.target = { member: node.member };
        return diagramNode;
      }
      case 'throw':
        return { id: node.id, title: node.label, subtitle: node.note ?? '例外を投げて終わる', tone: 'error' };
      case 'return':
        return { id: node.id, title: node.label, subtitle: node.note ?? '値を返して終わる', tone: 'end' };
      case 'end':
        return { id: node.id, title: '終了', subtitle: '最後まで実行して終わる', tone: 'end' };
    }
  });
  const edges: GraphEdge[] = flow.edges.map((edge) => {
    const text = edgeText(edge.label);
    const condition = flow.nodes.find((node) => node.id === edge.from && node.kind === 'condition');
    const label = condition === undefined || text === undefined ? text : `${condition.label}: ${text}`;
    return label === undefined ? { from: edge.from, to: edge.to, kind: edge.kind } : { from: edge.from, to: edge.to, label, kind: edge.kind };
  });
  const title = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node?.tone === 'end' && node.title !== '終了' ? node.title : (node?.title ?? id);
  };
  return {
    key: `fn:${card.id}`,
    nodes,
    edges,
    cases: deriveCases(nodes, edges, { errors: 'path', nodeLabel: title, nameBySink: true }),
  };
}
