/**
 * The request cases (premises.ts REQUEST_SCENARIOS, src/scenarios) as the
 * build of the map runs them on the live OP (packages/live-op): every case
 * of hono that needs nothing outside the OP is prepared on a workspace of
 * its own by its recipe (the requests that lead up to it, sent to the OP)
 * and its request sent; the trace of that last exchange (the order of what
 * it ran) is followed through the root of the case's endpoint the way the
 * map replays a request (map-analysis traced.ts followTrace), and the
 * ready-made ways the walk took (takenSelections) are the ways of the case.
 *
 * Each case is also checked for faithfulness: with every frame the request
 * ran open (all a reader can open, not only those of the calls that
 * failed), the walk agrees with what the request ran both ways (no
 * mismatch: it passes nothing the request did not run, and leaves out no
 * call of the map the request made nor a side the trace tells), the
 * request ran the root unless the case expects a status the router
 * answers, and the OP answered what the case expects (its status, its
 * OAuth error, the path it redirects to). Nothing here guesses a request or
 * a way: a case the OP could not prepare takes none, and says why.
 *
 * Express and Fastify are generated from hono and share its roots, so the
 * runs of hono stand for them; Next.js runs none.
 */
import {
  caseFaults,
  followTrace,
  FrameCatalog,
  RequestTrace,
  takenSelections,
  type CaseRun,
  type Failure,
  type FlowTree,
  type MapData,
  type RootRequests,
  type RunSources,
  type Selection,
  type TraceProbes,
  type TraceRun,
  type WalkMismatch,
} from '@maronn-openid-connect/map-analysis';
import { caseId, endpointSelections, type CaseTree } from './cases.js';
import type { RequestScenario } from './premises.js';

/** The last exchange of a case run on the live OP, as the build reads it (live-op api.ts LiveExchange). */
export interface CaseExchange {
  /** The id of the exchange in its workspace (`x7`). */
  id: string;
  method: string;
  /** The path and the query. */
  path: string;
  status?: number;
  /** The OAuth error of the response. */
  error?: string;
  response?: { status: number; headers: Array<[string, string]>; body?: string };
  /** What the app threw instead of answering. */
  thrown?: string;
  trace: TraceRun;
}

/** The live OP as the build runs the cases on it: the probes of its build, and the run of one case on a fresh workspace. */
export interface LiveCaseSource {
  probes: TraceProbes;
  /** Prepare a case on a workspace of its own and send its request: the exchange of that request, and how many requests prepared it. */
  run(id: string): Promise<{ exchange: CaseExchange; steps: number }>;
}

/** A case as the build ran it: its exchange and the requests that prepared it, or why it could not be run. */
export interface LiveCase {
  scenario: RequestScenario;
  exchange?: CaseExchange;
  steps: number;
  failure?: string;
}

/** The cases run on the live OP (runLiveCases), with the probes their traces index. */
export interface LiveCases {
  probes: TraceProbes;
  cases: LiveCase[];
  /** How long the runs took, in milliseconds. */
  took: number;
}

/** The cases of hono the live OP answers without anything outside it: not marked external, and not for another framework only. */
export function liveScenarios(scenarios: readonly RequestScenario[]): RequestScenario[] {
  return scenarios.filter((scenario) => scenario.external === undefined && scenario.frameworks?.includes('hono') !== false);
}

/** Run each case on the live OP, one after another (see the module comment); a case the OP could not prepare is kept with its failure. */
export async function runLiveCases(source: LiveCaseSource, scenarios: readonly RequestScenario[]): Promise<LiveCases> {
  const started = Date.now();
  const cases: LiveCase[] = [];
  for (const scenario of scenarios) {
    try {
      const { exchange, steps } = await source.run(scenario.id);
      cases.push({ scenario, exchange, steps });
    } catch (error) {
      cases.push({ scenario, steps: 0, failure: error instanceof Error ? error.message : String(error) });
    }
  }
  return { probes: source.probes, cases, took: Date.now() - started };
}

/** A case followed through the root of its endpoint: what the data says of it (CaseRun), and what the build prints of one that is not faithful. */
export interface FollowedCase {
  live: LiveCase;
  /** The `hono:<endpoint>` of its endpoint. */
  key: string;
  /** The root of its endpoint, by frame id; undefined when the map has no such endpoint. */
  root?: string;
  run: CaseRun;
  mismatches: WalkMismatch[];
  /** What is wrong with it (caseFaults, and the path it redirects to); none for a faithful case. */
  faults: string[];
}

/** A ready-made way of a root and the cases that took it, in the order of the cases. */
export interface FollowedWay {
  selection: Selection;
  id: string;
  scenarios: string[];
}

/** The cases run at one endpoint, followed through its root. */
export interface FollowedEndpoint {
  key: string;
  endpoint: string;
  root: string;
  /** The ways a case took, in the order of the ways of the root. */
  ways: FollowedWay[];
  cases: FollowedCase[];
}

/** The cases followed through their roots (followCases). */
export interface FollowedCases {
  probes: string;
  /** By `hono:<endpoint>`, in the order of the endpoints of hono. */
  endpoints: Map<string, FollowedEndpoint>;
  /** Every case, in the order they ran (those whose endpoint the map lacks too). */
  cases: FollowedCase[];
  took: number;
}

/** What the reading of the traces needs of the repository: the lines of a file by its path. */
export interface LiveReading {
  linesOf(path: string): readonly string[] | undefined;
}

/** The path a Location header names, read against the issuer the request was sent to; undefined for none. */
function locationPath(exchange: CaseExchange): string | undefined {
  const location = exchange.response?.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
  if (location === undefined) return undefined;
  try {
    return new URL(location, 'http://op.invalid').pathname;
  } catch {
    return location;
  }
}

/** The faults of a case run (map-analysis caseFaults), and a redirect to another path than the case expects. */
export function liveFaults(live: LiveCase, run: CaseRun): string[] {
  if (live.exchange === undefined) return [`the OP could not run it (${live.failure ?? 'no exchange'})`];
  const faults = caseFaults(run, live.scenario.expected);
  const expected = live.scenario.expected.redirectPath;
  const path = locationPath(live.exchange);
  if (expected !== undefined && path !== expected) faults.push(`it redirected to ${path ?? 'nowhere'} where the case expects ${expected}`);
  return faults;
}

/**
 * Follow each case's trace through the root of its endpoint and name the
 * ways it took (see the module comment): `trees` are the trees of the
 * working tree (with the value uses the choices read), `failures` the
 * failures that leave each frame, as the cases of the tests viewer are
 * made (cases.ts), so a way is the same case there and here.
 */
export function followCases(data: MapData, trees: ReadonlyMap<string, CaseTree>, failures: ReadonlyMap<string, readonly Failure[]>, live: LiveCases, reading: LiveReading): FollowedCases {
  const plain = new Map<string, FlowTree>([...trees].map(([id, built]) => [id, built.tree]));
  const catalog = new FrameCatalog(data);
  const sources: RunSources = {
    treeOf: (id) => plain.get(id),
    pathOf: (file) => data.sources[file]?.path,
    linesOf: (path) => reading.linesOf(path),
    frameAt: (path, line) => catalog.frameAt(path, line)?.id,
  };
  const endpoints = new Map<string, FollowedEndpoint & { selections: Array<{ selection: Selection; id: string }> }>();
  for (const endpoint of data.flows['hono']?.endpoints ?? []) {
    const built = trees.get(endpoint.root);
    const selections = built === undefined ? [] : endpointSelections(data, endpoint.root, built, plain, failures).map((selection) => ({ selection, id: caseId(selection) }));
    endpoints.set(`hono:${endpoint.id}`, { key: `hono:${endpoint.id}`, endpoint: endpoint.id, root: endpoint.root, ways: [], cases: [], selections });
  }
  const cases: FollowedCase[] = [];
  for (const item of live.cases) {
    const key = `hono:${item.scenario.endpoint}`;
    const endpoint = endpoints.get(key);
    const tree = endpoint === undefined ? undefined : plain.get(endpoint.root);
    const { exchange } = item;
    const run: CaseRun = { id: item.scenario.id, ...(exchange?.status === undefined ? {} : { status: exchange.status }), ...(exchange?.error === undefined ? {} : { error: exchange.error }), ways: [], rootRan: false, mismatches: 0, assumed: 0 };
    let mismatches: WalkMismatch[] = [];
    const faults: string[] = [];
    if (endpoint === undefined || tree === undefined) faults.push(`the map has no tree of the endpoint ${item.scenario.endpoint}`);
    else if (exchange !== undefined) {
      if (exchange.trace.probes !== live.probes.hash) faults.push(`its trace indexes the probes ${exchange.trace.probes}, not those of the OP (${live.probes.hash})`);
      if (exchange.trace.truncated === true) faults.push('its trace was cut');
      const trace = new RequestTrace(exchange.trace, live.probes, catalog);
      const followed = followTrace(trace, tree, sources, { open: trace.ranKeys(tree, sources.treeOf) });
      if (followed.needs.length > 0) faults.push(`the map has no tree of ${followed.needs.join(', ')}`);
      run.rootRan = followed.rootRan;
      run.mismatches = followed.mismatches.length;
      run.assumed = followed.walk?.assumed.length ?? 0;
      mismatches = followed.mismatches;
      if (followed.walk !== undefined) {
        const taken = new Set(takenSelections(endpoint.selections.map(({ selection }) => selection), followed.walk));
        run.ways = [...new Set(endpoint.selections.filter(({ selection }) => taken.has(selection)).map(({ id }) => id))];
      }
    }
    const followed: FollowedCase = { live: item, key, ...(endpoint === undefined ? {} : { root: endpoint.root }), run, mismatches, faults: [...faults, ...liveFaults(item, run)] };
    cases.push(followed);
    endpoint?.cases.push(followed);
  }
  const found = new Map<string, FollowedEndpoint>();
  for (const [key, { selections, ...endpoint }] of endpoints) {
    if (endpoint.cases.length === 0) continue;
    const ways = new Map<string, FollowedWay>();
    for (const { selection, id } of selections) {
      if (ways.has(id)) continue;
      const scenarios = endpoint.cases.filter((item) => item.run.ways.includes(id)).map((item) => item.run.id);
      if (scenarios.length > 0) ways.set(id, { selection, id, scenarios });
    }
    found.set(key, { ...endpoint, ways: [...ways.values()] });
  }
  return { probes: live.probes.hash, endpoints: found, cases, took: live.took };
}

/**
 * What the cases do at each root, for the flow view of the map
 * (RootRequests): the ways the cases took, each with the cases that took
 * it, and every case run at the root with what the OP answered and how its
 * walk went. Express and Fastify share these roots with hono.
 */
export function rootRequests(followed: FollowedCases): RootRequests[] {
  return [...followed.endpoints.values()].map((endpoint) => ({
    version: 4,
    root: endpoint.root,
    source: 'hono',
    endpoint: endpoint.endpoint,
    ways: endpoint.ways.map(({ selection, id, scenarios }) => ({ id, kind: selection.kind, name: selection.name, target: selection.target, scenarios })),
    cases: endpoint.cases.map((item) => item.run),
  }));
}

/** What the runs say in numbers: the cases run, the faithful ones, the mismatches, the cases with an assumed decision and those decisions, and the ways a case reached. */
export function liveCounts(followed: FollowedCases): { cases: number; faithful: number; mismatches: number; assumedCases: number; assumed: number; ways: number; endpoints: number } {
  const runs = followed.cases.map((item) => item.run);
  return {
    cases: runs.length,
    faithful: followed.cases.filter((item) => item.faults.length === 0).length,
    mismatches: runs.reduce((sum, run) => sum + run.mismatches, 0),
    assumedCases: runs.filter((run) => run.assumed > 0).length,
    assumed: runs.reduce((sum, run) => sum + run.assumed, 0),
    ways: [...followed.endpoints.values()].reduce((sum, endpoint) => sum + endpoint.ways.length, 0),
    endpoints: followed.endpoints.size,
  };
}

/** A case that is not faithful, as the build prints it: the case, what the OP answered (the Location and the start of the body), what is wrong, and where its walk disagrees with its trace. */
export function describeFault(item: FollowedCase): string[] {
  const { exchange } = item.live;
  const location = exchange?.response?.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
  const body = exchange?.response?.body?.replace(/\s+/g, ' ').slice(0, 200);
  const expected = item.live.scenario.expected;
  return [
    `${item.live.scenario.id} (${item.key}): ${exchange === undefined ? 'not run' : `${exchange.method} ${exchange.path} → ${exchange.status ?? `threw ${exchange.thrown ?? ''}`}${exchange.error === undefined ? '' : ` ${exchange.error}`}`} (exchange ${exchange?.id ?? '-'}; expects ${expected.status}${expected.error === undefined ? '' : ` ${expected.error}`}${expected.redirectPath === undefined ? '' : ` → ${expected.redirectPath}`})`,
    ...(location === undefined ? [] : [`  Location: ${location}`]),
    ...(body === undefined || body === '' ? [] : [`  body: ${body}`]),
    ...item.faults.map((fault) => `  - ${fault}`),
    ...item.mismatches.map((mismatch) => `  mismatch: ${mismatch.reason} at ${mismatch.frame === '' ? '(root)' : mismatch.frame} ${mismatch.node} \`${mismatch.code}\``),
  ];
}
