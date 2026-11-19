/**
 * The map of the generated provider, from the CLI command down to the
 * functions of core: what `maronn-oidc explain` walks and what a viewer
 * draws.
 *
 * The map joins three things the CLI already has: the commands and the
 * features of the registry, the flow of a generation (flow/build.ts: the
 * endpoints, their steps and arrows) and the function catalog
 * (extract/functions.ts: every function with its role and its calls). Of the
 * catalog it keeps the cards the steps reach: the function of each step and,
 * transitively, what those functions call.
 */
import { findFunctions, type FunctionCard, type FunctionCatalog } from '../extract/functions.js';
import { providerCatalog } from '../flow/build.js';
import type { FlowEndpoint, FlowStep, OpFlow } from '../flow/types.js';
import { FEATURE_REGISTRY, featureKeyOf, type FeatureTier } from '../registry.js';

export interface MapCommand {
  name: string;
  usage: string;
  summary: string;
}

export interface MapFeature {
  id: string;
  tier: FeatureTier;
  summary: string;
  /** Whether the map's configuration generates the feature. */
  enabled: boolean;
  /** The flag that turns the feature on (--enable) or off (--disable) from the default set. */
  flag: string;
  /** The endpoints the feature adds, by id (in any configuration). */
  endpoints: string[];
  /** The packages its generated code imports beside core. */
  packages: string[];
}

export interface OpMap {
  version: 2;
  /** The framework the modules are named for; absent when none was given. */
  framework?: string;
  commands: MapCommand[];
  frameworks: string[];
  features: MapFeature[];
  flow: OpFlow;
  /** The cards the steps of the flow reach, by id. */
  functions: Record<string, FunctionCard>;
}

export const MAP_COMMANDS: readonly MapCommand[] = [
  {
    name: 'generate',
    usage: 'maronn-oidc generate <framework> [--enable <features>] [--disable <features>] [--scope <scopes>] [--db <sql|kv>]',
    summary: 'Generate the provider: the endpoints below, one directory each, with one file per step',
  },
  {
    name: 'setup',
    usage: 'maronn-oidc setup <framework> [--entry <file>] [options of generate]',
    summary: 'Generate, then wire applyOidc() into an existing entry file (not for Next.js)',
  },
  {
    name: 'graph',
    usage: 'maronn-oidc graph [framework] [--detail steps] [--format json] [--flow <file>]',
    summary: 'Draw the endpoints and steps as boxes and arrows (Mermaid), or write the flow document',
  },
  {
    name: 'explain',
    usage: 'maronn-oidc explain [framework] [<endpoint>[/<step>] | fn <name>] [--depth <n>] [--callers] [--format json]',
    summary: 'Walk the map: the endpoints, the steps of one, the functions a step calls, a function and where it is used',
  },
];

export interface BuildOpMapOptions {
  flow: OpFlow;
  framework?: string;
  functions: FunctionCatalog;
  frameworks: string[];
}

/** The features of the registry, with the endpoints each adds (from the catalog of the provider). */
export function mapFeatures(flow: OpFlow): MapFeature[] {
  const endpointsOf = new Map<string, string[]>();
  for (const endpoint of providerCatalog().endpoints) {
    if (endpoint.feature === undefined) continue;
    endpointsOf.set(endpoint.feature, [...(endpointsOf.get(endpoint.feature) ?? []), endpoint.id]);
  }
  return FEATURE_REGISTRY.map((entry) => ({
    id: entry.id,
    tier: entry.tier,
    summary: entry.summary,
    enabled: flow.features[featureKeyOf(entry.id)] === true,
    flag: entry.tier === 'stable' ? `--disable ${entry.id}` : `--enable ${entry.id}`,
    endpoints: endpointsOf.get(entry.id) ?? [],
    packages: [...entry.packages],
  }));
}

/** The cards reached from some ids: the ids themselves and, transitively, what they call. */
export function reachableFunctions(
  catalog: FunctionCatalog,
  from: Iterable<string>,
  depth = Number.POSITIVE_INFINITY,
): Record<string, FunctionCard> {
  const reached: Record<string, FunctionCard> = {};
  let frontier = [...new Set(from)];
  let level = 0;
  while (frontier.length > 0 && level <= depth) {
    const next: string[] = [];
    for (const id of frontier) {
      if (reached[id] !== undefined) continue;
      const card = catalog.functions[id];
      if (card === undefined) continue;
      reached[id] = card;
      next.push(...card.calls);
    }
    frontier = next;
    level += 1;
  }
  return Object.fromEntries(Object.entries(reached).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The ids a step starts from: its function and its calls. */
export function stepRoots(step: FlowStep): string[] {
  return [...(step.functionId === undefined ? [] : [step.functionId]), ...step.calls];
}

/** Build the map (see the module comment). */
export function buildOpMap(options: BuildOpMapOptions): OpMap {
  const roots = options.flow.endpoints.flatMap((endpoint) => endpoint.steps.flatMap(stepRoots));
  const map: OpMap = {
    version: 2,
    ...(options.framework === undefined ? {} : { framework: options.framework }),
    commands: [...MAP_COMMANDS],
    frameworks: [...options.frameworks],
    features: mapFeatures(options.flow),
    flow: options.flow,
    functions: reachableFunctions(options.functions, roots),
  };
  return map;
}

/** Where a function is used in the provider: a step whose function it is, or whose code calls it. */
export interface StepUse {
  endpoint: FlowEndpoint;
  step: FlowStep;
  /** 'function': the card is the step's own function; 'call': the step's code calls it. */
  as: 'function' | 'call';
  /** The framework whose flow the use was found in (its steps are blocks for nextjs); absent for the source flow. */
  framework?: string;
}

/** The steps of a flow that use each function, by function id. */
export function stepUses(flow: OpFlow, framework?: string): Map<string, StepUse[]> {
  const uses = new Map<string, StepUse[]>();
  const add = (id: string, use: StepUse) => uses.set(id, [...(uses.get(id) ?? []), use]);
  const tag = framework === undefined ? {} : { framework };
  for (const endpoint of flow.endpoints) {
    for (const step of endpoint.steps) {
      if (step.functionId !== undefined) add(step.functionId, { endpoint, step, as: 'function', ...tag });
      for (const id of step.calls) add(id, { endpoint, step, as: 'call', ...tag });
    }
  }
  return uses;
}

/** An endpoint of the flow by id, or an error that lists the ids. */
export function endpointOf(flow: OpFlow, id: string): FlowEndpoint {
  const endpoint = flow.endpoints.find((candidate) => candidate.id === id);
  if (endpoint === undefined) {
    throw new Error(
      `Unknown endpoint "${id}". Endpoints of this configuration: ${flow.endpoints.map((e) => e.id).join(', ')}`,
    );
  }
  return endpoint;
}

/** A step of an endpoint by id, or an error that lists the ids. */
export function stepOf(endpoint: FlowEndpoint, id: string): FlowStep {
  const step = endpoint.steps.find((candidate) => candidate.id === id);
  if (step === undefined) {
    throw new Error(
      `Unknown step "${id}" of endpoint "${endpoint.id}". Steps of this endpoint: ${endpoint.steps.map((s) => s.id).join(', ')}`,
    );
  }
  return step;
}

/** The one card a name refers to, or an error that lists the candidates (or says there is none). */
export function functionOf(catalog: FunctionCatalog, name: string): FunctionCard {
  const found = findFunctions(catalog, name);
  if (found.length === 1) return found[0] as FunctionCard;
  if (found.length === 0) {
    throw new Error(`Unknown function "${name}". Name an exported function of core, experimental, google-login or of the apps (fn <name>, fn <root>:<name>)`);
  }
  throw new Error(
    `"${name}" names ${found.length} functions: ${found.map((card) => card.id).join(', ')}. Name one with fn <root>:<name> or its id`,
  );
}
