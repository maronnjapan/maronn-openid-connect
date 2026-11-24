/**
 * The OP of the map: one request run on the Hono OP of apps/hono (every
 * feature, as the map shows it), with what ran counted. Each request gets a
 * new OP (op.ts) on a copy of the database of the premises, its clock
 * stopped at theirs (clock.ts), so a request finds the premises as they are
 * whatever ran before it: the premises made by requests (prepare.ts) that
 * are given (the page hands over those the build made), with the key their
 * tokens were signed with; without them, the OP as it is configured (its
 * clients and users, seed.ts). A request keeps every header it is written
 * with, Cookie and Origin included, and its response the cookies it sets,
 * in a page too (op.ts). The send is recorded the way a measured test
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
import { generateRequestScenario, isStandaloneAuthorizationScenario, requestScenario } from '../../test-catalog/src/premises.js';
import type * as Api from './api.js';
import type { PlainDatabase } from './api.js';
import { candidateRequests, SAMPLED_ENDPOINTS } from './candidates.js';
import { decodeValue } from './codec.js';
import { importSigningKey, mapOp, onDatabase, responseHeaders, wholeRequest, type SigningKey } from './op.js';
import { PREMISES } from './premises.js';
import { preparePremises as prepare } from './prepare.js';
import { prepareScenarioRecipe, type ScenarioRecipe } from './scenario-runtime.js';
import { deviceRecipes } from './scenarios/device.js';
import { interactionRecipes } from './scenarios/interaction.js';
import { protocolRecipes } from './scenarios/protocol.js';
import { tokenRecipes } from './scenarios/token.js';
import { configuredDatabase } from './seed.js';
import { plainDatabase, storeAccess, watchDatabase } from './store.js';

export { candidateRequests, PREMISES, SAMPLED_ENDPOINTS };

/** What a request starts from: the database of the premises (copied for each request), its records as plain JSON, the key to sign with, the issuer and the clock. */
interface Base {
  db: MemoryDatabase;
  plain: PlainDatabase;
  key: SigningKey;
  issuer: string;
  now: number;
}

/** The base of the OP as it is configured, before any request (seed.ts), made once for the requests given no premises. */
let configured: Promise<Base> | undefined;
/** The base of the premises last given, by their JSON, made once for them. */
let given: { json: string; base: Promise<Base> } | undefined;

/** The base of the OP as it is configured: its clients and users, no code or token, and a key of its own. */
async function configuredBase(): Promise<Base> {
  const db = await configuredDatabase(PREMISES);
  return { db, plain: plainDatabase(db), key: await rs256Key('map-sandbox-rs256-key'), issuer: PREMISES.issuer, now: PREMISES.now };
}

/** The base of premises made by requests: their database made again, their key, their issuer and their clock. */
async function preparedBase(premises: Api.PreparedPremises): Promise<Base> {
  const db = decodeValue(premises.database) as MemoryDatabase;
  return { db, plain: plainDatabase(db), key: await importSigningKey(premises.signingKey), issuer: premises.issuer, now: premises.now };
}

/** The base a request starts from: that of the premises given, else that of the OP as it is configured. */
async function baseOf(premises: Api.PreparedPremises | undefined): Promise<Base> {
  if (premises === undefined) return (configured ??= configuredBase());
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

/** Run an operation after the preceding one has released the provider and the clock. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = previous.then(operation);
  previous = result.catch(() => undefined);
  return result;
}

/** Run a request on the OP of the map (see the module comment and api.ts), after the runs asked for before it. */
export function runRequest(request: Api.SandboxRequest, premises?: Api.PreparedPremises): Promise<Api.SandboxRun> {
  return enqueue(() => runAlone(request, premises));
}

/** Make the premises by requests (prepare.ts), those of the map unless others are given, after the runs asked for before, as it stops the clock of the process too. */
export function preparePremises(plan: Api.Premises = PREMISES): Promise<Api.PreparedPremises> {
  return enqueue(() => prepare(plan));
}

const recipes: Readonly<Record<string, ScenarioRecipe>> = { ...protocolRecipes, ...interactionRecipes, ...tokenRecipes, ...deviceRecipes };

/** Generate the request and make the provider state that will receive it. */
export function prepareRequestScenario(id: string, framework = 'hono'): Promise<Api.PreparedRequestScenario> {
  return enqueue(async () => {
    const scenario = requestScenario(id, framework);
    if (scenario === undefined) throw new Error(`Unknown request case for ${framework}: ${id}`);
    if (isStandaloneAuthorizationScenario(id)) {
      const generated = await generateRequestScenario(id, { issuer: PREMISES.issuer });
      const registration = generated.registration;
      const premises = await prepare({
        ...PREMISES,
        now: generated.issuedAt,
        grants: [],
        clients: [{
          clientId: registration.client_id,
          authMethod: registration.token_endpoint_auth_method,
          grantTypes: registration.grant_types,
          redirectUris: registration.redirect_uris,
          requestObjectKeys: registration.jwks?.keys,
        }],
      });
      return { generated, premises };
    }
    const recipe = recipes[id];
    if (recipe === undefined) throw new Error(`No recipe for request case: ${id}`);
    const { request, premises } = await prepareScenarioRecipe(recipe, id);
    const url = new URL(request.path, premises.issuer);
    const path = framework === 'nextjs' ? scenario.nextjs?.path : undefined;
    if (path !== undefined) url.pathname = path;
    const generated = {
      request: { ...request, path: `${url.pathname}${url.search}`, host: url.host },
      url: url.href,
      issuedAt: premises.now,
    };
    return { generated, premises };
  });
}

/** Run a request on the OP of the map, no other running. */
async function runAlone(request: Api.SandboxRequest, premises: Api.PreparedPremises | undefined): Promise<Api.SandboxRun> {
  const base = await baseOf(premises);
  const db = structuredClone(base.db);
  return onDatabase(db, base.now, async () => {
    const op = mapOp(db, base.key, base.issuer);
    const sent = wholeRequest(new URL(request.path, base.issuer), { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
    resetExchanges();
    const reads = watchDatabase(db);
    let answered: Response | undefined;
    await recordExchange(sent, async (message) => (answered = await op.fetch(message))).catch(() => undefined);
    const [exchange] = takeExchanges();
    if (exchange === undefined) throw new Error('The OP of the map recorded no exchange.');
    // The cookies the response sets, which a page's Response drops from its headers.
    const response = exchange.response === undefined || answered === undefined ? exchange.response : { ...exchange.response, headers: responseHeaders(answered) };
    return {
      request: exchange.request,
      ...(response === undefined ? {} : { response }),
      ...(exchange.error === undefined ? {} : { error: exchange.error }),
      ran: byRepositoryPath(exchange.ran),
      store: storeAccess(reads, base.plain, db),
    };
  }, premises?.postLogoutRedirectUris);
}

runRequest satisfies typeof Api.runRequest;
preparePremises satisfies typeof Api.preparePremises;
prepareRequestScenario satisfies typeof Api.prepareRequestScenario;
PREMISES satisfies typeof Api.PREMISES;
candidateRequests satisfies typeof Api.candidateRequests;
SAMPLED_ENDPOINTS satisfies typeof Api.SAMPLED_ENDPOINTS;
