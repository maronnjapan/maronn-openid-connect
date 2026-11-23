/**
 * A request for each case of an endpoint that the OP of the map takes it
 * with (packages/map-sandbox), so the flow view of the map can start the
 * request of a case from one that takes it there. The build runs the
 * requests the OP of the map tries at an endpoint (its candidates: the
 * requests a client sends, and each changed in one place) one after
 * another, and reads each against the cases of the endpoint with the rules
 * a test's request is read with (examples.ts takes): the first request that
 * takes a case is its sample. A case none of them takes has none; nothing
 * here guesses a request.
 */
import type { FlowTree } from '@maronn-openid-connect/map-analysis';
import { RequestRun, requestOf, takes, type CaseSources, type CaseWay } from './examples.js';
import type { RawExchange } from './model.js';

/** A request run on the OP of the map: what it sent, what came back, and what ran, as a measured test's request (RawExchange). */
export type SampleRun = Pick<RawExchange, 'request' | 'response' | 'error' | 'ran'>;

/** A request to run on the OP of the map (map-sandbox SandboxRequest). */
export interface SampleRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body?: string;
}

/** The OP of the map, as the build runs it (map-sandbox): the endpoints it tries, the requests it tries at each, and the run of one. */
export interface SampleSource {
  endpoints: readonly string[];
  candidates(endpoint: string): readonly SampleRequest[];
  run(request: SampleRequest): Promise<SampleRun>;
}

/**
 * Run the requests the OP of the map tries at each endpoint it tries, one
 * after another (the OP stops the clock of the process while one runs), by
 * `hono:<endpoint>`: the requests of the hono OP, which Express and Fastify
 * share. A request the OP refuses to make is left out.
 */
export async function runSamples(source: SampleSource): Promise<Map<string, SampleRun[]>> {
  const runs = new Map<string, SampleRun[]>();
  for (const endpoint of source.endpoints) {
    const ran: SampleRun[] = [];
    for (const request of source.candidates(endpoint)) {
      try {
        ran.push(await source.run(request));
      } catch {
        // A request the OP of the map cannot make: there is nothing to read.
      }
    }
    runs.set(`hono:${endpoint}`, ran);
  }
  return runs;
}

/**
 * Give each case of an endpoint without a sample the first run that takes
 * it (see the module comment), and say how many got one. A run that did not
 * answer, or whose URL cannot be read, takes none.
 */
export function attachSamples(ways: readonly CaseWay[], runs: readonly SampleRun[], tree: FlowTree, sources: CaseSources): number {
  let found = 0;
  for (const sampled of runs) {
    const { response } = sampled;
    const request = requestOf(sampled);
    if (response === undefined || request === undefined) continue;
    const run = new RequestRun(sampled, sources);
    for (const way of ways) {
      if (way.made.sample !== undefined || !takes(way, tree, run, response, sources)) continue;
      const { status, statusText, headers, body, truncated } = response;
      way.made.sample = { request, response: { status, ...(statusText === undefined || statusText === '' ? {} : { statusText }), headers, ...(body === undefined ? {} : { body }), ...(truncated === true ? { truncated } : {}) } };
      found += 1;
    }
  }
  return found;
}
