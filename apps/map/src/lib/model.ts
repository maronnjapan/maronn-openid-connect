/**
 * The pure parts of the page: which endpoints and steps a configuration shows,
 * the command line that configuration is, where a function is used, the
 * geometry of the step diagram, and search. Nothing here touches the DOM.
 */
import type { FlowEdge, FlowEndpoint, FlowStep, FunctionCard, MapData, MapFeature, OpFlow, StepKind } from '../types';

export const KINDS: readonly StepKind[] = ['parse', 'resolve', 'validate', 'decide', 'dispatch', 'issue', 'persist', 'transform', 'respond'];

/** The OidcFeatureConfig key of a feature id: refresh-token → refreshToken. */
export function featureKey(id: string): string {
  return id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The feature a step or an endpoint names, by its key (refreshToken) or its id (refresh-token). */
export function featureOf(features: readonly MapFeature[], key: string | undefined): MapFeature | undefined {
  if (key === undefined) return undefined;
  return features.find((feature) => feature.id === key || featureKey(feature.id) === key);
}

/** The flag that generates a step or an endpoint: the flag of its feature, or "every provider". */
export function flagOf(features: readonly MapFeature[], key: string | undefined): string {
  if (key === undefined) return 'every provider';
  return featureOf(features, key)?.flag ?? `feature: ${key}`;
}

/** The ids of the features a fresh page has on: the default set, so the first view is `maronn-oidc generate <framework>`. */
export function defaultEnabled(features: readonly MapFeature[]): Set<string> {
  return new Set(features.filter((feature) => feature.tier === 'stable').map((feature) => feature.id));
}

/** The endpoints of a flow the enabled features generate, each with the steps those features generate. */
export function visibleEndpoints(flow: OpFlow, features: readonly MapFeature[], enabled: ReadonlySet<string>): FlowEndpoint[] {
  const on = (key: string | undefined) => {
    if (key === undefined) return true;
    const feature = featureOf(features, key);
    return feature === undefined ? true : enabled.has(feature.id);
  };
  return flow.endpoints
    .filter((endpoint) => on(endpoint.feature))
    .map((endpoint) => ({ ...endpoint, steps: endpoint.steps.filter((step) => on(step.feature)) }));
}

/** The `maronn-oidc generate` command line of a configuration. */
export function commandLine(framework: string, features: readonly MapFeature[], enabled: ReadonlySet<string>): string {
  const parts = [`maronn-oidc generate ${framework}`];
  const enable = features.filter((feature) => feature.tier !== 'stable' && enabled.has(feature.id)).map((feature) => feature.id);
  const disable = features.filter((feature) => feature.tier === 'stable' && !enabled.has(feature.id)).map((feature) => feature.id);
  if (enable.length > 0) parts.push(`--enable ${enable.join(',')}`);
  if (disable.length > 0) parts.push(`--disable ${disable.join(',')}`);
  return parts.join(' \\\n  ');
}

/** Where a function is used in a flow: the step whose function it is, or the steps whose code calls it. */
export interface StepUse {
  endpoint: FlowEndpoint;
  step: FlowStep;
  as: 'function' | 'call';
}

export function usesOf(flow: OpFlow, id: string): StepUse[] {
  const uses: StepUse[] = [];
  for (const endpoint of flow.endpoints) {
    for (const step of endpoint.steps) {
      if (step.functionId === id) uses.push({ endpoint, step, as: 'function' });
      else if (step.calls.includes(id)) uses.push({ endpoint, step, as: 'call' });
    }
  }
  return uses;
}

/** The marker line of a step, as the generated code writes it: `[id] (feature: f) Label — Spec`. */
export function markerOf(step: FlowStep, features: readonly MapFeature[]): string {
  const feature = step.feature === undefined ? '' : ` (feature: ${featureOf(features, step.feature)?.id ?? step.feature})`;
  return `[${step.id}]${feature} ${step.label}${step.spec === undefined ? '' : ` — ${step.spec}`}`;
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

// ---- the step diagram

export const BOX_W = 340;
export const BOX_H = 46;
const GAP = 26;
const PAD = 20;
const ARC = 70;

export interface FlowBox {
  step: FlowStep;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowArrow {
  edge: FlowEdge;
  /** The SVG path. */
  d: string;
  label?: { text: string; x: number; y: number };
}

export interface FlowLayout {
  width: number;
  height: number;
  boxes: FlowBox[];
  arrows: FlowArrow[];
}

/**
 * The steps of an endpoint as a column of boxes, the arrows between
 * consecutive steps straight, the others as arcs on the right (errors on the
 * left, when drawn). The width leaves room for the arcs and their labels.
 */
export function layoutFlow(endpoint: FlowEndpoint, showErrors: boolean): FlowLayout {
  const steps = endpoint.steps;
  const index = new Map(steps.map((step, i) => [step.id, i]));
  const drawn = endpoint.edges.filter(
    (edge) => (edge.kind !== 'error' || showErrors) && index.has(edge.from) && index.has(edge.to),
  );
  const bulgeOf = (edge: FlowEdge) => 30 + Math.min(90, Math.abs((index.get(edge.to) ?? 0) - (index.get(edge.from) ?? 0)) * 7);
  const arcs = drawn.filter((edge) => edge.kind !== 'error' && index.get(edge.to) !== (index.get(edge.from) ?? 0) + 1);
  const labelWidth = Math.max(0, ...arcs.map((edge) => (edge.label ? edge.label.length * 6 + 8 : 0)));
  const rightMargin = Math.max(PAD, ...arcs.map((edge) => bulgeOf(edge) + labelWidth + PAD));
  const x0 = PAD + ARC;
  const yOf = (i: number) => PAD + i * (BOX_H + GAP);
  const boxes: FlowBox[] = steps.map((step, i) => ({ step, x: x0, y: yOf(i), width: BOX_W, height: BOX_H }));
  const arrows: FlowArrow[] = [];
  for (const edge of drawn) {
    const a = index.get(edge.from) as number;
    const b = index.get(edge.to) as number;
    if (edge.kind === 'flow' && b === a + 1) {
      arrows.push({ edge, d: `M${x0 + BOX_W / 2},${yOf(a) + BOX_H} L${x0 + BOX_W / 2},${yOf(b)}` });
      continue;
    }
    const side = edge.kind === 'error' ? -1 : 1;
    const xEdge = side > 0 ? x0 + BOX_W : x0;
    const ya = yOf(a) + BOX_H / 2;
    const yb = yOf(b) + BOX_H / 2;
    const bulge = side * bulgeOf(edge);
    const arrow: FlowArrow = { edge, d: `M${xEdge},${ya} C${xEdge + bulge},${ya} ${xEdge + bulge},${yb} ${xEdge},${yb}` };
    // The apex of the curve sits at 3/4 of the bulge; the label starts just past it.
    if (edge.label && edge.kind !== 'error') arrow.label = { text: edge.label, x: xEdge + bulge * 0.75 + 4, y: (ya + yb) / 2 + 3 };
    arrows.push(arrow);
  }
  return {
    width: PAD + ARC + BOX_W + rightMargin,
    height: Math.max(PAD * 2 + BOX_H, PAD * 2 + steps.length * (BOX_H + GAP) - GAP),
    boxes,
    arrows,
  };
}

// ---- search

export interface SearchHit {
  what: string;
  text: string;
  sub: string;
  target: { endpoint: string; step: string } | { fn: string };
}

export function search(data: MapData, endpoints: readonly FlowEndpoint[], query: string, limit = 40): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const endpoint of endpoints) {
    for (const step of endpoint.steps) {
      if (step.id.includes(q) || step.label.toLowerCase().includes(q) || step.function.toLowerCase().includes(q)) {
        hits.push({ what: 'step', text: `[${step.id}] ${step.label}`, sub: `${endpoint.methods.join('|')} ${endpoint.path}`, target: { endpoint: endpoint.id, step: step.id } });
      }
    }
  }
  for (const card of Object.values(data.functions)) {
    if (card.name.toLowerCase().includes(q)) hits.push({ what: card.package, text: `${card.name}()`, sub: card.module, target: { fn: card.id } });
  }
  return hits.slice(0, limit);
}

/** The cards named `name`, for a link that names a function instead of an id. */
export function cardsNamed(data: MapData, name: string): FunctionCard[] {
  return Object.values(data.functions).filter((card) => card.name === name);
}
