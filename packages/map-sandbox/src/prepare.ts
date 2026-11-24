/**
 * The premises of the OP of the map made the way an OP comes to hold them
 * (PreparedPremises): the clients and the users it is configured with, put
 * into its database as an operator registers them (seed.ts), and the codes
 * and tokens it issued, by running on it the requests that issue them. For
 * each grant of the premises (premises.ts), a browser of its own sends the
 * client's authorization request, follows the OP's redirects to its own
 * pages, and submits the form of each page as the user would (the login
 * form with the user's name and password, the consent approved), up to the
 * redirect back to the client with a code (or the form posting it back,
 * for response_mode=form_post); a grant exchanged then sends the code to
 * the token endpoint with the client's credentials, the way the client is
 * registered to send them. Every request
 * is kept with what the OP answered and the records it added, changed or
 * removed (store.ts), and every record of the database after the last with
 * the request that added it: the map says of a record a request reads
 * which request stored it, with no record of the premises written by hand.
 *
 * The build of the map makes them in Node, and the page makes them again
 * when the reader changes a grant: a page drops the Cookie and the Origin
 * of a request it makes and the Set-Cookie of a response it reads, so the
 * browser here gives the OP its requests with their headers whole and
 * keeps the cookies the OP's responses are made with (op.ts).
 */
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { rs256Key } from '../../../apps/hono/src/test-support/keys.js';
import type { PlainDatabase, PremiseRecord, PremiseStep, PreparedGrant, PreparedPremises, SandboxMessage, SandboxRequest } from './api.js';
import { cookieHeaders, keepCookies, submittedForm, type CookieJar } from './browser-session.js';
import { encodeValue } from './codec.js';
import { exportSigningKey, mapOp, onDatabase, responseHeaders, setCookiesOf, wholeRequest } from './op.js';
import type { PremiseClient, PremiseGrant, Premises } from './premises.js';
import { configuredDatabase } from './seed.js';
import { changesBetween, plainDatabase } from './store.js';

/** The most requests a browser of a grant sends after the authorization request before it gives up: login page, login, consent page, consent, and some to spare. */
const MOST_PAGES = 8;

/** The bodies are cut at this many characters, as a measured test's exchange cuts them (16 KiB). */
const BODY_LIMIT = 16 * 1024;

/** The OP the requests of the premises are sent to, with the steps they made so far. */
interface Making {
  op: { fetch: (request: Request) => Response | Promise<Response> };
  db: MemoryDatabase;
  issuer: string;
  steps: PremiseStep[];
}

/** A body as a step keeps it: absent when empty, cut at BODY_LIMIT characters. */
function bodyOf(text: string | undefined): Pick<SandboxMessage, 'body' | 'truncated'> {
  if (text === undefined || text === '') return {};
  return text.length > BODY_LIMIT ? { body: text.slice(0, BODY_LIMIT), truncated: true } : { body: text };
}

/**
 * Send a request of a grant to the OP as a browser does (its cookies, and
 * the Origin of a form posted from the OP's page), and keep it as a step
 * with what the OP answered (the body of a page left out) and the records
 * it wrote. Returns the response and the text of its body.
 */
async function send(making: Making, grant: string, jar: CookieJar | undefined, method: string, url: string, init: { headers?: Array<[string, string]>; body?: string } = {}): Promise<{ response: Response; text: string; url: string }> {
  const headers: Array<[string, string]> = [...(init.headers ?? [])];
  if (jar !== undefined) headers.push(...cookieHeaders(jar));
  const request = wholeRequest(new URL(url, making.issuer), { method, headers, ...(init.body === undefined ? {} : { body: init.body }) });
  const before = plainDatabase(making.db);
  const response = await making.op.fetch(request);
  const text = await response.text();
  if (jar !== undefined) keepCookies(jar, setCookiesOf(response));
  const page = (response.headers.get('content-type') ?? '').startsWith('text/html');
  making.steps.push({
    grant,
    request: { method, url: request.url, headers: [...request.headers].map(([name, value]): [string, string] => [name.toLowerCase(), value]), ...bodyOf(init.body) },
    response: { status: response.status, ...(response.statusText === '' ? {} : { statusText: response.statusText }), headers: responseHeaders(response), ...(page ? {} : bodyOf(text)) },
    wrote: changesBetween(before, plainDatabase(making.db)),
  });
  return { response, text, url: request.url };
}

/** The headers and the fields a client authenticates with at the token endpoint, the way it is registered (RFC 6749 §2.3.1: in the Authorization header, or in the body with its secret; a public client by its id alone). */
function clientCredentials(client: PremiseClient): { headers: Array<[string, string]>; fields: Array<[string, string]> } {
  const secret = client.clientSecret ?? '';
  if (client.authMethod === 'client_secret_basic') return { headers: [['authorization', `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`)}`]], fields: [] };
  if (client.authMethod === 'client_secret_post') return { headers: [], fields: [['client_id', client.clientId], ['client_secret', secret]] };
  return { headers: [], fields: [['client_id', client.clientId]] };
}

/**
 * The code the OP gave the client: in the query of the redirect to its
 * redirect_uri, in the fragment of it (response_mode=fragment), or among
 * the fields of the form the OP's page posts to it (response_mode=form_post);
 * undefined when the response is none of these.
 */
function codeOf(response: Response, text: string, issuer: string, redirectUri: string, user: { username: string; password: string }): string | undefined {
  const location = response.headers.get('location');
  if (location !== null) {
    const back = new URL(location, issuer);
    if (`${back.origin}${back.pathname}` !== redirectUri) return undefined;
    return back.searchParams.get('code') ?? new URLSearchParams(back.hash.slice(1)).get('code') ?? undefined;
  }
  const form = response.status === 200 ? submittedForm(text, user) : undefined;
  return form?.action === redirectUri ? form.fields.find(([name]) => name === 'code')?.[1] : undefined;
}

/** What running a grant gave: what it left to use (none when the OP gave no code), and why it is not what the grant asked for (the OP gave no code, or did not exchange it). */
interface GrantOutcome {
  prepared?: PreparedGrant;
  failure?: NonNullable<PreparedPremises['failures']>[number];
}

/**
 * Run the requests of a grant (see the module comment) and return what it
 * left to use, and the failure when the OP does not redirect back to the
 * client with a code (nothing left), or does not answer the exchange with
 * tokens (the code left, unexchanged): the premises would not be what they
 * say. It throws for a grant that names no user or client of the premises.
 */
async function runGrant(making: Making, premises: Premises, grant: PremiseGrant): Promise<GrantOutcome> {
  const user = premises.users.find((candidate) => candidate.username === grant.username);
  const clientId = grant.authorize.client_id ?? '';
  const client = premises.clients.find((candidate) => candidate.clientId === clientId);
  const redirectUri = grant.authorize.redirect_uri ?? '';
  if (user === undefined || client === undefined) throw new Error(`The grant ${grant.id} names a user or a client the premises do not have`);
  const jar: CookieJar = new Map();
  const origin = new URL(making.issuer).origin;
  // The browser stays on the OP: it follows a redirect to the OP's pages and submits a form that posts to the OP; a redirect or a form to the client ends it.
  let { response, text } = await send(making, grant.id, jar, 'GET', `/authorize?${new URLSearchParams(grant.authorize)}`);
  for (let page = 0; page < MOST_PAGES; page += 1) {
    const location = response.headers.get('location');
    const form = response.status === 200 ? submittedForm(text, user) : undefined;
    if (location !== null && new URL(location, making.issuer).origin === origin) ({ response, text } = await send(making, grant.id, jar, 'GET', location));
    else if (form !== undefined && new URL(form.action, making.issuer).origin === origin) ({ response, text } = await send(making, grant.id, jar, 'POST', form.action, { headers: [['content-type', 'application/x-www-form-urlencoded'], ['origin', origin]], body: new URLSearchParams(form.fields).toString() }));
    else break;
  }
  const code = codeOf(response, text, making.issuer, redirectUri, user);
  if (code === undefined) return { failure: { grant: grant.id, stage: 'authorization', message: `The OP did not give the code of the grant ${grant.id}: it answered ${response.status} ${response.headers.get('location') ?? ''}` } };
  const prepared: PreparedGrant = { id: grant.id, clientId, redirectUri, code, codeVerifier: grant.codeVerifier };
  if (!grant.exchange) return { prepared };
  const credentials = clientCredentials(client);
  const exchanged = await send(making, grant.id, undefined, 'POST', '/token', {
    headers: [['content-type', 'application/x-www-form-urlencoded'], ...credentials.headers],
    body: new URLSearchParams([['grant_type', 'authorization_code'], ['code', code], ['redirect_uri', redirectUri], ['code_verifier', grant.codeVerifier], ...credentials.fields]).toString(),
  });
  if (exchanged.response.status !== 200) return { prepared, failure: { grant: grant.id, stage: 'exchange', message: `The OP did not exchange the code of the grant ${grant.id}: it answered ${exchanged.response.status} ${exchanged.text}` } };
  return { prepared: { ...prepared, tokens: JSON.parse(exchanged.text) as Record<string, unknown> } };
}

/**
 * The records of the database after the steps, each with the step that
 * added it last and the steps that changed it after; a record no step
 * added is one of the configuration.
 */
function recordsOf(steps: readonly PremiseStep[], after: PlainDatabase): PremiseRecord[] {
  const records: PremiseRecord[] = [];
  for (const [collection, entries] of Object.entries(after)) {
    for (const [key, value] of Object.entries(entries)) {
      let addedBy: number | undefined;
      let changedBy: number[] = [];
      steps.forEach((step, index) => {
        for (const change of step.wrote) {
          if (change.collection !== collection || change.key !== key) continue;
          if (change.change === 'added') {
            addedBy = index;
            changedBy = [];
          } else if (change.change === 'changed') changedBy.push(index);
        }
      });
      records.push({ collection, key, value, ...(addedBy === undefined ? {} : { addedBy }), ...(changedBy.length === 0 ? {} : { changedBy }) });
    }
  }
  return records;
}

/** The grants and HTTP responses available while preparing a request on the same OP. */
export interface PremiseRequestsContext {
  issuer: string;
  now: number;
  grants: readonly PreparedGrant[];
  /** Send the next setup request and return the full response for the next one to use. */
  send(request: SandboxRequest): Promise<{ status: number; headers: Array<[string, string]>; body: string; url: string }>;
}

/** Make the grants, then run any other setup requests before taking the database snapshot. */
export async function prepareWithRequests<T>(
  premises: Premises,
  label: string,
  finish: (context: PremiseRequestsContext) => T | Promise<T>,
): Promise<{ result: T; premises: PreparedPremises }> {
  const db = await configuredDatabase(premises);
  const key = await rs256Key('map-sandbox-rs256-key');
  const making: Making = { op: mapOp(db, key, premises.issuer), db, issuer: premises.issuer, steps: [] };
  const failures: NonNullable<PreparedPremises['failures']> = [];
  const { grants, result } = await onDatabase(db, premises.now, async () => {
    const grants: PreparedGrant[] = [];
    for (const grant of premises.grants) {
      // The requests a grant sent stay among the steps, a failed one's too: the reader reads which one the OP refused, and how.
      const { prepared, failure } = await runGrant(making, premises, grant);
      if (prepared !== undefined) grants.push(prepared);
      if (failure !== undefined) failures.push(failure);
    }
    const result = await finish({
      issuer: premises.issuer,
      now: premises.now,
      grants,
      async send(request) {
        const { response, text, url } = await send(making, label, undefined, request.method, request.path, request);
        return { status: response.status, headers: responseHeaders(response), body: text, url };
      },
    });
    return { grants, result };
  }, premises.postLogoutRedirectUris);
  return {
    result,
    premises: {
      version: 1,
      issuer: premises.issuer,
      ...(premises.postLogoutRedirectUris === undefined ? {} : { postLogoutRedirectUris: premises.postLogoutRedirectUris }),
      now: premises.now,
      steps: making.steps,
      records: recordsOf(making.steps, plainDatabase(db)),
      grants,
      ...(failures.length === 0 ? {} : { failures }),
      database: encodeValue(db),
      signingKey: await exportSigningKey(key),
    },
  };
}

/** Make the premises by sending their grants' requests. */
export async function preparePremises(premises: Premises): Promise<PreparedPremises> {
  const prepared = await prepareWithRequests(premises, '', () => undefined);
  return prepared.premises;
}
