/**
 * The OP of the map: one request run on the Hono OP of apps/hono (every
 * feature, as the map shows it), with what ran counted. Each request gets a
 * new OP (op.ts) on a copy of the database of the premises, its clock
 * stopped at theirs (clock.ts), so a request finds the premises as they are
 * whatever ran before it: the premises made by requests when they are given
 * (prepare.ts, with the key their tokens were signed with), else the
 * records of the tests (seed.ts). The send is recorded the way a measured test
 * records the requests it sends (test-reach recordExchange): the counters
 * of the files of the function catalog (counted by Istanbul as in the
 * measured tests, istanbul.ts) that went up between the start of the send
 * and the end of the response, by repository path. The map reads them with
 * the rules the test catalog reads a test's request with (map-analysis
 * observe.ts). What the request read and wrote of the records the OP held
 * is noted too (store.ts): the records it looked up, found or not, and those
 * it added, changed or removed.
 *
 * The OP sends no request out: the fetch it is given for a client's
 * jwks_uri or a request_uri refuses, and so does the fetch of the global
 * scope while a request runs.
 */
import { recordExchange, resetExchanges, takeExchanges } from '@maronn-openid-connect/test-reach/exchanges';
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { rs256Key } from '../../../apps/hono/src/test-support/keys.js';
import type * as Api from './api.js';
import type { PlainDatabase } from './api.js';
import { candidateRequests, SAMPLED_ENDPOINTS } from './candidates.js';
import { decodeValue } from './codec.js';
import { importSigningKey, mapOp, onDatabase, type SigningKey } from './op.js';
import { PREMISES } from './premises.js';
import { preparePremises as prepare } from './prepare.js';
import { seededDatabase } from './seed.js';
import { plainDatabase, storeAccess, watchDatabase } from './store.js';

export { candidateRequests, PREMISES, SAMPLED_ENDPOINTS };

/** What a request starts from: the database of the premises (copied for each request), its records as plain JSON, the key to sign with, and the clock. */
interface Base {
  db: MemoryDatabase;
  plain: PlainDatabase;
  key: SigningKey;
  now: number;
}

/** The base of the records of the tests (seed.ts), made once. */
let seeded: Promise<Base> | undefined;
/** The base of the premises last given, by their JSON, made once for them. */
let given: { json: string; base: Promise<Base> } | undefined;

/** The base of the records of the tests (seed.ts). */
async function seededBase(): Promise<Base> {
  const db = await seededDatabase(PREMISES);
  return { db, plain: plainDatabase(db), key: await rs256Key('map-sandbox-rs256-key'), now: PREMISES.now };
}

/** The base of premises made by requests: their database made again, and their key. */
async function preparedBase(premises: Api.PreparedPremises): Promise<Base> {
  const db = decodeValue(premises.database) as MemoryDatabase;
  return { db, plain: plainDatabase(db), key: await importSigningKey(premises.signingKey), now: premises.now };
}

/** The base a request starts from: that of the premises given, else that of the records of the tests. */
function baseOf(premises: Api.PreparedPremises | undefined): Promise<Base> {
  if (premises === undefined) return (seeded ??= seededBase());
  const json = JSON.stringify(premises);
  if (given?.json !== json) given = { json, base: preparedBase(premises) };
  return given.base;
}

/** The repository paths of what ran: the counters name each file as its repository path behind a `/` (istanbul.ts). */
function byRepositoryPath(ran: Record<string, Api.RanInFile>): Record<string, Api.RanInFile> {
  return Object.fromEntries(Object.entries(ran).map(([path, counters]) => [path.replace(/^\//, ''), counters]));
}

/** The run before the next: a request waits for it, as the clock and the counters a run reads are the process's. */
let previous: Promise<unknown> = Promise.resolve();

/** Run a request on the OP of the map (see the module comment and api.ts), after the runs asked for before it. */
export function runRequest(request: Api.SandboxRequest, premises?: Api.PreparedPremises): Promise<Api.SandboxRun> {
  const run = previous.then(
    () => runAlone(request, premises),
    () => runAlone(request, premises),
  );
  previous = run.catch(() => undefined);
  return run;
}

/** Make the premises by requests (prepare.ts), those of the map unless others are given, after the runs asked for before, as it stops the clock of the process too. */
export function preparePremises(premises: Api.Premises = PREMISES): Promise<Api.PreparedPremises> {
  const made = previous.then(
    () => prepare(premises),
    () => prepare(premises),
  );
  previous = made.catch(() => undefined);
  return made;
}

/** Run a request on the OP of the map, no other running. */
async function runAlone(request: Api.SandboxRequest, premises: Api.PreparedPremises | undefined): Promise<Api.SandboxRun> {
  const base = await baseOf(premises);
  const db = structuredClone(base.db);
  return onDatabase(db, base.now, async () => {
    const op = mapOp(db, base.key, PREMISES.issuer);
    const sent = new Request(new URL(request.path, PREMISES.issuer), { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
    resetExchanges();
    const reads = watchDatabase(db);
    await recordExchange(sent, (message) => op.fetch(message)).catch(() => undefined);
    const [exchange] = takeExchanges();
    if (exchange === undefined) throw new Error('The OP of the map recorded no exchange.');
    return {
      request: exchange.request,
      ...(exchange.response === undefined ? {} : { response: exchange.response }),
      ...(exchange.error === undefined ? {} : { error: exchange.error }),
      ran: byRepositoryPath(exchange.ran),
      store: storeAccess(reads, base.plain, db),
    };
  });
}

runRequest satisfies typeof Api.runRequest;
preparePremises satisfies typeof Api.preparePremises;
PREMISES satisfies typeof Api.PREMISES;
candidateRequests satisfies typeof Api.candidateRequests;
SAMPLED_ENDPOINTS satisfies typeof Api.SAMPLED_ENDPOINTS;
