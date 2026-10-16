/**
 * Render an OpFlow as a Mermaid flowchart.
 *
 * Two levels of detail:
 * - `endpoints`: one box per endpoint, grouped by protocol flow, with the
 *   arrows a client or browser follows between them.
 * - `steps`: every endpoint is a subgraph holding one box per step (one
 *   generated function), with the arrows of its pipeline. The endpoint-level
 *   arrows connect the subgraphs.
 */
import type { FlowEdge, FlowEndpoint, FlowStep, OpFlow } from './types.js';
import { FLOW_STEP_KINDS } from './catalog.js';

export type MermaidDetail = 'endpoints' | 'steps';

export interface RenderMermaidOptions {
  /** Default: 'endpoints'. */
  detail?: MermaidDetail;
  /** Draw only these endpoints (and the arrows among them). Default: all. */
  endpoints?: string[];
  /** Draw the dashed arrows into the error-responding steps. Default: true. */
  errorEdges?: boolean;
}

/** Mermaid node ids allow letters, digits and underscores; the catalog uses kebab-case. */
function nodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function stepNodeId(endpointId: string, stepId: string): string {
  return `${nodeId(endpointId)}__${nodeId(stepId)}`;
}

/** Escape a label for a double-quoted Mermaid label. */
function label(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

function arrow(edge: FlowEdge): string {
  switch (edge.kind) {
    case 'error':
      return edge.label === undefined ? '-.->' : `-. ${edge.label} .->`;
    case 'branch':
    case 'flow':
      return edge.label === undefined ? '-->' : `-->|${label(edge.label)}|`;
  }
}

function endpointLabel(endpoint: FlowEndpoint): string {
  return label(`${endpoint.methods.join('|')} ${endpoint.path}<br/>${endpoint.label}`);
}

function stepLabel(step: FlowStep): string {
  const lines = [`<b>${step.label}</b>`, `${step.function}()`];
  if (step.spec !== undefined) lines.push(`<small>${step.spec}</small>`);
  return label(lines.join('<br/>'));
}

/** One fill per step kind, so a diagram reads by responsibility at a glance. */
const STEP_KIND_STYLES: Record<FlowStep['kind'], string> = {
  parse: 'fill:#eef2ff,stroke:#4f46e5',
  resolve: 'fill:#ecfeff,stroke:#0891b2',
  validate: 'fill:#fff7ed,stroke:#ea580c',
  decide: 'fill:#fefce8,stroke:#ca8a04',
  dispatch: 'fill:#f5f3ff,stroke:#7c3aed',
  issue: 'fill:#f0fdf4,stroke:#16a34a',
  persist: 'fill:#f0fdfa,stroke:#0f766e',
  transform: 'fill:#fdf4ff,stroke:#c026d3',
  respond: 'fill:#f8fafc,stroke:#475569',
};

function selectEndpoints(flow: OpFlow, only: string[] | undefined): FlowEndpoint[] {
  if (only === undefined) return flow.endpoints;
  const wanted = new Set(only);
  const unknown = only.filter((id) => !flow.endpoints.some((e) => e.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown endpoint: ${unknown.map((id) => `"${id}"`).join(', ')}. ` +
        `Endpoints of this configuration: ${flow.endpoints.map((e) => e.id).join(', ')}`,
    );
  }
  return flow.endpoints.filter((e) => wanted.has(e.id));
}

function groupedEndpoints(endpoints: FlowEndpoint[]): Map<string, { label: string; endpoints: FlowEndpoint[] }> {
  const groups = new Map<string, { label: string; endpoints: FlowEndpoint[] }>();
  for (const endpoint of endpoints) {
    const group = groups.get(endpoint.group.id) ?? { label: endpoint.group.label, endpoints: [] };
    group.endpoints.push(endpoint);
    groups.set(endpoint.group.id, group);
  }
  return groups;
}

function renderEndpointLevel(flow: OpFlow, endpoints: FlowEndpoint[]): string {
  const lines = ['flowchart LR'];
  for (const [groupId, group] of groupedEndpoints(endpoints)) {
    lines.push(`  subgraph ${nodeId(groupId)}[${label(group.label)}]`);
    for (const endpoint of group.endpoints) {
      lines.push(`    ${nodeId(endpoint.id)}[${endpointLabel(endpoint)}]`);
    }
    lines.push('  end');
  }
  const ids = new Set(endpoints.map((e) => e.id));
  for (const edge of flow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    lines.push(`  ${nodeId(edge.from)} ${arrow(edge)} ${nodeId(edge.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderStepLevel(flow: OpFlow, endpoints: FlowEndpoint[], errorEdges: boolean): string {
  const lines = ['flowchart TD'];
  const usedKinds = new Set<FlowStep['kind']>();
  for (const endpoint of endpoints) {
    lines.push(`  subgraph ${nodeId(endpoint.id)}[${endpointLabel(endpoint)}]`);
    lines.push('    direction TB');
    for (const step of endpoint.steps) {
      usedKinds.add(step.kind);
      lines.push(`    ${stepNodeId(endpoint.id, step.id)}[${stepLabel(step)}]:::${step.kind}`);
    }
    for (const edge of endpoint.edges) {
      if (edge.kind === 'error' && !errorEdges) continue;
      lines.push(
        `    ${stepNodeId(endpoint.id, edge.from)} ${arrow(edge)} ${stepNodeId(endpoint.id, edge.to)}`,
      );
    }
    lines.push('  end');
  }
  const ids = new Set(endpoints.map((e) => e.id));
  for (const edge of flow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    lines.push(`  ${nodeId(edge.from)} ${arrow(edge)} ${nodeId(edge.to)}`);
  }
  for (const kind of FLOW_STEP_KINDS) {
    if (usedKinds.has(kind)) lines.push(`  classDef ${kind} ${STEP_KIND_STYLES[kind]}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Render the flow as a Mermaid flowchart (see the module comment). */
export function renderMermaid(flow: OpFlow, options: RenderMermaidOptions = {}): string {
  const endpoints = selectEndpoints(flow, options.endpoints);
  if ((options.detail ?? 'endpoints') === 'endpoints') {
    return renderEndpointLevel(flow, endpoints);
  }
  return renderStepLevel(flow, endpoints, options.errorEdges ?? true);
}
