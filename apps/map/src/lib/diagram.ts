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
    .replace(/^catch › /, '例外が起きたとき › ');
}

/** The steps of an endpoint and their arrows. */
export function endpointDiagram(endpoint: FlowEndpoint, data: MapData): Diagram {
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
  return {
    key: `endpoint:${endpoint.id}`,
    nodes,
    edges,
    cases: deriveCases(nodes, edges, { errors: 'modifier', nodeLabel: label, nameBySink: false }),
  };
}

/** The flow inside a function; undefined for a function without one. */
export function functionDiagram(card: FunctionCard, data: MapData): Diagram | undefined {
  const flow = card.flow;
  if (flow === undefined) return undefined;
  const nodes: DiagramNode[] = flow.nodes.map((node) => {
    switch (node.kind) {
      case 'start':
        return { id: node.id, title: node.label, subtitle: card.summary, tone: 'start' };
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
    return text === undefined ? { from: edge.from, to: edge.to, kind: edge.kind } : { from: edge.from, to: edge.to, label: text, kind: edge.kind };
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
