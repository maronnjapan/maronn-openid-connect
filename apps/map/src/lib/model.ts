/**
 * The pure parts of the page: which endpoints and steps a configuration shows,
 * the command line that configuration is, where a function is used and who
 * calls it, and search. Nothing here touches the DOM.
 */
import type { FlowEndpoint, FlowStep, FunctionEntry, MapData, MapFeature, OpFlow } from '../types';

/** A function of the catalog as the index has it. */
type FunctionCard = FunctionEntry;

/** The OidcFeatureConfig key of a feature id: refresh-token → refreshToken. */
export function featureKey(id: string): string {
  return id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The feature a step or an endpoint names, by its key (refreshToken) or its id (refresh-token). */
export function featureOf(features: readonly MapFeature[], key: string | undefined): MapFeature | undefined {
  if (key === undefined) return undefined;
  return features.find((feature) => feature.id === key || featureKey(feature.id) === key);
}

/** When a step or an endpoint is generated, in words: always, or with the flag of its feature. */
export function generatedWhen(features: readonly MapFeature[], key: string | undefined): string {
  if (key === undefined) return '常に生成される';
  const feature = featureOf(features, key);
  if (feature === undefined) return `機能 ${key} で生成される`;
  return feature.tier === 'stable' ? `既定で生成される（${feature.flag} で外せる）` : `${feature.flag} で生成される`;
}

/** The ids of the features a fresh page has on: the default set, so the first view is `maronn-oidc generate <framework>`. */
export function defaultEnabled(features: readonly MapFeature[]): Set<string> {
  return new Set(features.filter((feature) => feature.tier === 'stable').map((feature) => feature.id));
}

/**
 * The endpoints of a flow the enabled features generate, each with the steps
 * those features generate and the arrows between the steps that remain.
 */
export function visibleEndpoints(flow: OpFlow, features: readonly MapFeature[], enabled: ReadonlySet<string>): FlowEndpoint[] {
  const on = (key: string | undefined) => {
    if (key === undefined) return true;
    const feature = featureOf(features, key);
    return feature === undefined ? true : enabled.has(feature.id);
  };
  return flow.endpoints
    .filter((endpoint) => on(endpoint.feature))
    .map((endpoint) => {
      const steps = endpoint.steps.filter((step) => on(step.feature));
      const kept = new Set(steps.map((step) => step.id));
      return { ...endpoint, steps, edges: endpoint.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) };
    });
}

/** The ids of the features that are on, as the markers of the code name them (`refresh-token`): what the trees are narrowed by. */
export function enabledMarkers(features: readonly MapFeature[], enabled: ReadonlySet<string>): Set<string> {
  return new Set(features.filter((feature) => enabled.has(feature.id)).map((feature) => feature.id));
}

/**
 * The features that must be on to show an endpoint and one of its steps (a
 * link, or a caller that names them, may point at those of a feature that is
 * off): their ids, empty when everything is shown already.
 */
export function featuresToShow(
  flow: OpFlow,
  features: readonly MapFeature[],
  enabled: ReadonlySet<string>,
  endpointId: string | null,
  stepId: string | null,
): string[] {
  const endpoint = flow.endpoints.find((candidate) => candidate.id === endpointId);
  if (endpoint === undefined) return [];
  const step = endpoint.steps.find((candidate) => candidate.id === stepId);
  const needed = [endpoint.feature, step?.feature]
    .map((key) => featureOf(features, key))
    .filter((feature): feature is MapFeature => feature !== undefined && !enabled.has(feature.id))
    .map((feature) => feature.id);
  return [...new Set(needed)];
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

/** Where a function is used in a flow: the step whose function it is, or a step whose code calls it. */
export interface StepUse {
  endpoint: FlowEndpoint;
  step: FlowStep;
  as: 'function' | 'call';
}

/** The steps of a flow that use a function directly. */
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

/** The endpoints whose trace starts from a frame (a Route Handler, a pipeline function). */
export function endpointsRootedAt(flow: OpFlow, id: string): FlowEndpoint[] {
  return flow.endpoints.filter((endpoint) => endpoint.root === id);
}

/** A step of an endpoint that reaches a function, and the functions between them. */
export interface EndpointUse {
  endpoint: FlowEndpoint;
  step: FlowStep;
  /** The step's function itself, a call of its code, or a call further down. */
  as: 'function' | 'call' | 'indirect';
  /** The functions from the step down to the one asked about, that one left out (empty unless indirect). */
  via: FunctionCard[];
}

/**
 * The steps that reach a function, directly or through the functions that
 * call it, each once by its shortest way, in the order of the endpoints and
 * their steps.
 */
export function endpointsUsing(data: MapData, flow: OpFlow, id: string, maxDepth = 8): EndpointUse[] {
  const found = new Map<string, EndpointUse>();
  const seen = new Set<string>([id]);
  let frontier: Array<{ id: string; via: FunctionCard[] }> = [{ id, via: [] }];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: Array<{ id: string; via: FunctionCard[] }> = [];
    for (const item of frontier) {
      for (const use of usesOf(flow, item.id)) {
        const key = `${use.endpoint.id}/${use.step.id}`;
        if (found.has(key)) continue;
        const as = item.via.length === 0 ? use.as : 'indirect';
        found.set(key, { endpoint: use.endpoint, step: use.step, as, via: item.via });
      }
      for (const caller of data.functions[item.id]?.calledBy ?? []) {
        const card = data.functions[caller];
        if (card === undefined || seen.has(caller)) continue;
        seen.add(caller);
        next.push({ id: caller, via: [card, ...item.via] });
      }
    }
    frontier = next;
  }
  const endpointOrder = new Map(flow.endpoints.map((endpoint, index) => [endpoint.id, index]));
  return [...found.values()].sort(
    (a, b) =>
      (endpointOrder.get(a.endpoint.id) ?? 0) - (endpointOrder.get(b.endpoint.id) ?? 0) ||
      a.endpoint.steps.indexOf(a.step) - b.endpoint.steps.indexOf(b.step),
  );
}

/**
 * The endpoints whose own file holds a function: the Route Handler of a
 * Next.js endpoint and the functions beside it (`app/token/route.ts`), or a
 * function of the pipeline.ts of a Hono endpoint. Their steps are blocks of
 * that file, so no step calls the function by name.
 */
export function endpointsInModule(flow: OpFlow, card: Pick<FunctionCard, 'package' | 'module'>): FlowEndpoint[] {
  return flow.endpoints.filter((endpoint) => holdsFunction(endpoint, card));
}

/** Whether the own file of an endpoint (the route.ts of Next.js, the pipeline.ts of Hono) holds a function. */
export function holdsFunction(endpoint: Pick<FlowEndpoint, 'module'>, card: Pick<FunctionCard, 'package' | 'module'>): boolean {
  const root = card.package === 'nextjs' ? 'app/' : card.package === 'hono' ? 'oidc-provider/' : undefined;
  return root !== undefined && endpoint.module !== undefined && `${root}${endpoint.module}` === card.module;
}

/** The functions whose body calls a function, by name. */
export function callersOf(data: MapData, card: FunctionCard): FunctionCard[] {
  return card.calledBy
    .map((id) => data.functions[id])
    .filter((caller): caller is FunctionCard => caller !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Where a card lives, for a developer to open it: `core client-auth.ts:123`. */
export function locationOf(card: { package: string; module: string; line: number }): string {
  return `${card.package} ${card.module}:${card.line}`;
}

// ---- search

export interface SearchHit {
  /** ステップ or the package of a function. */
  what: string;
  text: string;
  sub: string;
  target: { endpoint: string; step: string } | { fn: string };
}

/** Steps whose id, label or function name and functions whose name hold the query (two characters or more). */
export function search(data: MapData, endpoints: readonly FlowEndpoint[], query: string, limit = 40): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const endpoint of endpoints) {
    for (const step of endpoint.steps) {
      if (step.id.includes(q) || step.label.toLowerCase().includes(q) || step.function.toLowerCase().includes(q)) {
        hits.push({ what: 'ステップ', text: step.label, sub: `${endpoint.methods.join('|')} ${endpoint.path}`, target: { endpoint: endpoint.id, step: step.id } });
      }
    }
  }
  for (const card of Object.values(data.functions)) {
    if (card.name.toLowerCase().includes(q)) hits.push({ what: card.package, text: `${card.name}()`, sub: card.summary, target: { fn: card.id } });
  }
  return hits.slice(0, limit);
}

/** The cards named `name`, for a link that names a function instead of an id. */
export function cardsNamed(data: MapData, name: string): FunctionCard[] {
  return Object.values(data.functions).filter((card) => card.name === name);
}
