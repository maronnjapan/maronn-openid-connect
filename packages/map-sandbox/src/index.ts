/**
 * The OP of the map: one request run on the Hono OP of apps/hono (every
 * feature, as the map shows it), with what ran counted. Each request gets a
 * new OP on a copy of the seeded database (seed.ts), its clock stopped at
 * the premises' (clock.ts), so a request finds the premises as they are
 * whatever ran before it. The send is recorded the way a measured test
 * records the requests it sends (test-reach recordExchange): the counters
 * of the files of the function catalog (counted by Istanbul as in the
 * measured tests, istanbul.ts) that went up between the start of the send
 * and the end of the response, by repository path. The map reads them with
 * the rules the test catalog reads a test's request with (map-analysis
 * observe.ts).
 *
 * The OP sends no request out: the fetch it would send to a client's
 * jwks_uri or to a request_uri refuses.
 */
import { recordExchange, resetExchanges, takeExchanges } from '@maronn-openid-connect/test-reach/exchanges';
import { createApp } from '../../../apps/hono/src/oidc-provider/app.js';
import { createClientKeyResolver, createClientResolver } from '../../../apps/hono/src/oidc-provider/db/memory/clients.js';
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { createProviderStores } from '../../../apps/hono/src/oidc-provider/db/memory/stores.js';
import { rs256Key, staticKeyProvider } from '../../../apps/hono/src/test-support/keys.js';
import type * as Api from './api.js';
import { candidateRequests, SAMPLED_ENDPOINTS } from './candidates.js';
import { atClock } from './clock.js';
import { PREMISES } from './premises.js';
import { seededDatabase } from './seed.js';

export { candidateRequests, PREMISES, SAMPLED_ENDPOINTS };

/** The global the OP's memory database is kept on (db/memory/database.ts createDatabase): a request's own while it runs. */
const DATABASE_KEY = '__oidcMemoryDatabase';

let seeded: Promise<MemoryDatabase> | undefined;
let key: ReturnType<typeof rs256Key> | undefined;

/** The OP's fetch: it refuses, as the OP of the map sends no request out of the page. */
async function refuseFetch(): Promise<never> {
  throw new Error('The OP of the map sends no request out.');
}

/** The repository paths of what ran: the counters name each file as its repository path behind a `/` (istanbul.ts). */
function byRepositoryPath(ran: Record<string, Api.RanInFile>): Record<string, Api.RanInFile> {
  return Object.fromEntries(Object.entries(ran).map(([path, counters]) => [path.replace(/^\//, ''), counters]));
}

/** The run before the next: a request waits for it, as the clock and the counters a run reads are the process's. */
let previous: Promise<unknown> = Promise.resolve();

/** Run a request on the OP of the map (see the module comment and api.ts), after the runs asked for before it. */
export function runRequest(request: Api.SandboxRequest): Promise<Api.SandboxRun> {
  const run = previous.then(
    () => runAlone(request),
    () => runAlone(request),
  );
  previous = run.catch(() => undefined);
  return run;
}

/** Run a request on the OP of the map, no other running. */
async function runAlone(request: Api.SandboxRequest): Promise<Api.SandboxRun> {
  return atClock(PREMISES.now * 1000, async () => {
    seeded ??= seededDatabase(PREMISES);
    key ??= rs256Key('map-sandbox-rs256-key');
    const db = structuredClone(await seeded);
    const global = globalThis as Record<string, unknown>;
    const before = global[DATABASE_KEY];
    global[DATABASE_KEY] = db;
    try {
      const app = createApp({
        signingKeyProvider: staticKeyProvider(await key),
        storage: createProviderStores(db),
        clientResolver: createClientResolver(db),
        clientKeyResolver: createClientKeyResolver(db),
        outboundFetch: refuseFetch,
        config: { issuer: PREMISES.issuer },
      });
      const sent = new Request(new URL(request.path, PREMISES.issuer), { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
      resetExchanges();
      await recordExchange(sent, (message) => app.fetch(message)).catch(() => undefined);
      const [exchange] = takeExchanges();
      if (exchange === undefined) throw new Error('The OP of the map recorded no exchange.');
      return {
        request: exchange.request,
        ...(exchange.response === undefined ? {} : { response: exchange.response }),
        ...(exchange.error === undefined ? {} : { error: exchange.error }),
        ran: byRepositoryPath(exchange.ran),
      };
    } finally {
      global[DATABASE_KEY] = before;
    }
  });
}

runRequest satisfies typeof Api.runRequest;
PREMISES satisfies typeof Api.PREMISES;
candidateRequests satisfies typeof Api.candidateRequests;
SAMPLED_ENDPOINTS satisfies typeof Api.SAMPLED_ENDPOINTS;
