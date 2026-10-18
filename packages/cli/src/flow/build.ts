/**
 * The OpFlow of a generation, built from the descriptions the app gives of
 * its endpoints and steps (the catalog of extract/meta.ts: the `meta` of every
 * step, the `endpoint` of every endpoint.ts, the `contribution` of a feature).
 *
 * `maronn-oidc graph` draws it and `--flow` checks a document against it, so
 * a box of the diagram is always one function of the generated code: both
 * come from the same files.
 */
import type { DbKind } from '../db.js';
import type { EdgeMeta, EndpointMeta, SourceCatalog, StepMeta } from '../extract/meta.js';
import { readExtractionDefinition, readSourceCatalog, readSourceFiles } from '../extract/templates.js';
import { enabledFeatureIds, featureKeyOf, type OidcFeatureConfig } from '../registry.js';
import type { FlowEdge, FlowEndpoint, FlowStep, FlowStepKind, OpFlow } from './types.js';

export interface BuildOpFlowOptions {
  features: OidcFeatureConfig;
  /** Custom scopes declared with --scope (default: none). */
  scopes?: string[];
  /** --db kind (default: none, the in-memory stores). */
  db?: DbKind;
  /** The catalog to build from (default: the one of the hono app). */
  catalog?: SourceCatalog;
}

/** The step kinds, in the order the legend of a diagram lists them. */
export const FLOW_STEP_KINDS: readonly FlowStepKind[] = [
  'parse',
  'resolve',
  'validate',
  'decide',
  'dispatch',
  'issue',
  'persist',
  'transform',
  'respond',
];

let defaultCatalog: SourceCatalog | undefined;

/** The catalog of the hono app, the one every framework's diagram is drawn from. */
export function providerCatalog(): SourceCatalog {
  if (defaultCatalog === undefined) {
    const definition = readExtractionDefinition();
    const framework = definition.frameworks['hono'];
    if (!framework) throw new Error('extract.json has no hono framework');
    const files = readSourceFiles(framework.source, definition);
    defaultCatalog = readSourceCatalog(framework.source, framework.root, files, definition);
  }
  return defaultCatalog;
}

/**
 * Build the OpFlow of a generation: the endpoints the features produce, in
 * the order of their descriptions, with their steps and arrows.
 */
export function buildOpFlow(options: BuildOpFlowOptions): OpFlow {
  const catalog = options.catalog ?? providerCatalog();
  const enabled = new Set(enabledFeatureIds(options.features));
  const isOn = (feature: string | undefined) => feature === undefined || enabled.has(feature);
  const endpoints = catalog.endpoints
    .filter((endpoint) => isOn(endpoint.feature))
    .sort((a, b) => a.order - b.order)
    .map((endpoint) => buildEndpoint(endpoint, catalog, isOn));
  const ids = new Set(endpoints.map((endpoint) => endpoint.id));
  const journeys = catalog.endpoints
    .filter((endpoint) => isOn(endpoint.feature))
    .flatMap((endpoint) => endpoint.journeys ?? [])
    .filter((journey) => ids.has(journey.from) && ids.has(journey.to))
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...edge }) => toEdge(edge));
  return {
    version: 1,
    features: { ...options.features },
    scopes: [...(options.scopes ?? [])],
    db: options.db ?? null,
    endpoints,
    edges: journeys,
  };
}

function buildEndpoint(
  meta: EndpointMeta & { file: string },
  catalog: SourceCatalog,
  isOn: (feature: string | undefined) => boolean,
): FlowEndpoint {
  const listed: StepMeta[] = meta.steps
    .map((id) => catalog.steps.find((step) => step.endpoint === meta.id && step.id === id))
    .filter((step): step is StepMeta & { file: string } => step !== undefined && isOn(step.feature))
    .map((step) => withContributions(step, catalog, isOn))
    // A step of an endpoint a feature serves belongs to that feature already.
    .map((step) => (step.feature !== undefined && step.feature === meta.feature ? { ...step, feature: undefined } : step));
  // An optional input is listed only when a step of this generation defines it.
  const defined = new Set([...(meta.initial ?? []), ...listed.flatMap((step) => step.produces)]);
  const steps = listed.map((step) =>
    step.optional === undefined
      ? step
      : { ...step, consumes: step.consumes.filter((name) => !step.optional!.includes(name) || defined.has(name)) },
  );
  return {
    id: meta.id,
    label: meta.label,
    path: meta.path,
    methods: [...meta.methods],
    layer: meta.layer,
    group: { ...meta.group },
    ...(meta.spec === undefined ? {} : { spec: meta.spec }),
    ...(meta.feature === undefined ? {} : { feature: featureKeyOf(meta.feature) }),
    rearrangeable: meta.rearrangeable,
    ...(meta.initial === undefined ? {} : { initial: [...meta.initial] }),
    steps: steps.map(toFlowStep),
    edges: endpointEdges(meta, steps),
  };
}

/** A step with what the enabled features contribute to it (contribute() of a feature). */
function withContributions(step: StepMeta, catalog: SourceCatalog, isOn: (feature: string | undefined) => boolean): StepMeta {
  const contributions = catalog.contributions.filter(
    (contribution) =>
      contribution.endpoint === step.endpoint && contribution.step === step.id && isOn(contribution.feature),
  );
  if (contributions.length === 0) return step;
  const calls = [...(step.calls ?? []), ...contributions.flatMap((contribution) => contribution.calls ?? [])];
  const consumes = [...step.consumes];
  for (const name of contributions.flatMap((contribution) => contribution.consumes ?? [])) {
    if (!consumes.includes(name)) consumes.unshift(name);
  }
  const specs = contributions.flatMap((contribution) => (contribution.spec === undefined ? [] : [contribution.spec]));
  const spec = specs.length === 0 ? step.spec : [step.spec, ...specs].filter((part) => part !== undefined).join(' / ');
  return { ...step, calls, consumes, ...(spec === undefined ? {} : { spec }) };
}

function toFlowStep(step: StepMeta): FlowStep {
  return {
    calls: [...(step.calls ?? [])],
    consumes: [...step.consumes],
    produces: [...step.produces],
    removable: step.removable,
    id: step.id,
    label: step.label,
    kind: step.kind,
    ...(step.spec === undefined ? {} : { spec: step.spec }),
    function: step.function,
    ...(step.feature === undefined ? {} : { feature: featureKeyOf(step.feature) }),
    ...(step.fallback === undefined ? {} : { fallback: step.fallback }),
    ...(step.after === undefined ? {} : { after: [...step.after] }),
    ...(step.before === undefined ? {} : { before: [...step.before] }),
    ...(step.calledFrom === undefined ? {} : { calledFrom: [...step.calledFrom] }),
  };
}

function toEdge(edge: EdgeMeta): FlowEdge {
  return edge.label === undefined
    ? { from: edge.from, to: edge.to, kind: edge.kind }
    : { from: edge.from, to: edge.to, label: edge.label, kind: edge.kind };
}

/** The arrows of an endpoint, from its edge description (see EndpointEdges of the app). */
function endpointEdges(meta: EndpointMeta, steps: readonly StepMeta[]): FlowEdge[] {
  const present = new Set(steps.map((step) => step.id));
  const branchSteps = new Set(
    (meta.edges.forks ?? []).flatMap((fork) => fork.branches.map((branch) => branch.step)),
  );
  const off = new Set([...(meta.edges.off ?? []), ...branchSteps]);
  const edges: FlowEdge[] = [];
  if (meta.edges.chain) {
    const stages = steps.map((step) => step.id).filter((id) => id !== meta.errorStep && !off.has(id));
    for (let index = 0; index + 1 < stages.length; index += 1) {
      const from = stages[index] as string;
      const to = stages[index + 1] as string;
      const branches = (meta.edges.forks ?? [])
        .filter((fork) => fork.at === from)
        .flatMap((fork) => fork.branches)
        .filter((branch) => present.has(branch.step));
      if (branches.length === 0) {
        edges.push({ from, to, kind: 'flow' });
        continue;
      }
      for (const branch of branches) {
        edges.push({ from, to: branch.step, label: branch.label, kind: 'branch' });
        edges.push({ from: branch.step, to, kind: 'flow' });
      }
    }
  }
  for (const rule of meta.edges.fromKind ?? []) {
    if (!present.has(rule.to)) continue;
    for (const step of steps) {
      if (step.kind === rule.kind) edges.push({ from: step.id, to: rule.to, label: rule.label, kind: 'branch' });
    }
  }
  for (const edge of meta.edges.extra ?? []) {
    if (present.has(edge.from) && present.has(edge.to)) edges.push(toEdge(edge));
  }
  if (meta.errorStep !== undefined && present.has(meta.errorStep)) {
    for (const step of steps) {
      if (step.kind !== 'respond' && step.id !== meta.errorStep) {
        edges.push({ from: step.id, to: meta.errorStep, kind: 'error' });
      }
    }
  }
  return edges;
}
