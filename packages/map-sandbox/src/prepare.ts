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
 * Made in Node (the build of the map, the tests): a browser drops the
 * Cookie and the Origin of a request a page makes and the Set-Cookie of a
 * response it reads, so the login and the consent fail there, and the page
 * takes the premises made here instead (index.ts runRequest).
 */
import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { rs256Key } from '../../../apps/hono/src/test-support/keys.js';
import type { PlainDatabase, PremiseRecord, PremiseStep, PreparedGrant, PreparedPremises, SandboxMessage } from './api.js';
import { encodeValue } from './codec.js';
import { exportSigningKey, mapOp, onDatabase } from './op.js';
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

/** What a browser holds between two requests of a grant: its cookies, by name. */
type CookieJar = Map<string, string>;

/** Keep the cookies a response sets, and forget those it clears (an empty value, or Max-Age=0). */
function keepCookies(jar: CookieJar, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair = ''] = cookie.split(';');
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (value === '' || /;\s*max-age=0\s*(;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

/** The headers of a message as an exchange keeps them: lower-case names in the order Headers gives them. */
function headersOf(headers: Headers): Array<[string, string]> {
  return [...headers].map(([name, value]): [string, string] => [name.toLowerCase(), value]);
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
async function send(making: Making, grant: string, jar: CookieJar | undefined, method: string, url: string, init: { headers?: Array<[string, string]>; body?: string } = {}): Promise<{ response: Response; text: string }> {
  const headers: Array<[string, string]> = [...(init.headers ?? [])];
  if (jar !== undefined && jar.size > 0) headers.push(['cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; ')]);
  const request = new Request(new URL(url, making.issuer), { method, headers, ...(init.body === undefined ? {} : { body: init.body }) });
  const before = plainDatabase(making.db);
  const response = await making.op.fetch(request);
  const text = await response.text();
  if (jar !== undefined) keepCookies(jar, response);
  const page = (response.headers.get('content-type') ?? '').startsWith('text/html');
  making.steps.push({
    grant,
    request: { method, url: request.url, headers: headersOf(request.headers), ...bodyOf(init.body) },
    response: { status: response.status, ...(response.statusText === '' ? {} : { statusText: response.statusText }), headers: headersOf(response.headers), ...(page ? {} : bodyOf(text)) },
    wrote: changesBetween(before, plainDatabase(making.db)),
  });
  return { response, text };
}

/** A character reference of HTML made again (`&amp;` → `&`): the OP escapes `&`, `<`, `>` and the quotes in the values of its pages. */
function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[name] ?? '');
}

/** The value of an attribute of an HTML tag; undefined without it. */
function attributeOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? undefined : unescapeHtml(match[1] ?? '');
}

/**
 * The form of an OP's page as a user submits it: where it posts, and its
 * fields, the hidden ones as they are, the text and password inputs with
 * the user's name and password, and the submit button that approves (the
 * first one when none does). Undefined for a page without a form that posts.
 */
function submittedForm(html: string, user: { username: string; password: string }): { action: string; fields: Array<[string, string]> } | undefined {
  const form = /<form\b[^>]*>/i.exec(html)?.[0];
  if (form === undefined || (attributeOf(form, 'method') ?? '').toLowerCase() !== 'post') return undefined;
  const fields: Array<[string, string]> = [];
  for (const [input] of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = attributeOf(input, 'name');
    if (name === undefined) continue;
    const type = (attributeOf(input, 'type') ?? 'text').toLowerCase();
    if (type === 'hidden') fields.push([name, attributeOf(input, 'value') ?? '']);
    else if (type === 'password') fields.push([name, user.password]);
    else if (type === 'text') fields.push([name, user.username]);
  }
  const buttons = [...html.matchAll(/<button\b[^>]*>/gi)].map(([tag]) => tag).filter((tag) => (attributeOf(tag, 'type') ?? 'submit') === 'submit' && attributeOf(tag, 'name') !== undefined);
  const button = buttons.find((tag) => attributeOf(tag, 'value') === 'approve') ?? buttons[0];
  if (button !== undefined) fields.push([attributeOf(button, 'name') ?? '', attributeOf(button, 'value') ?? '']);
  return { action: attributeOf(form, 'action') ?? '', fields };
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

/**
 * Run the requests of a grant (see the module comment) and return what it
 * left to use. It throws when the OP does not redirect back to the client
 * with a code, or does not answer the exchange with tokens: the premises
 * would not be what they say.
 */
async function runGrant(making: Making, premises: Premises, grant: PremiseGrant): Promise<PreparedGrant> {
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
  if (code === undefined) throw new Error(`The OP did not give the code of the grant ${grant.id}: it answered ${response.status} ${response.headers.get('location') ?? ''}`);
  const prepared: PreparedGrant = { id: grant.id, clientId, redirectUri, code, codeVerifier: grant.codeVerifier };
  if (!grant.exchange) return prepared;
  const credentials = clientCredentials(client);
  const exchanged = await send(making, grant.id, undefined, 'POST', '/token', {
    headers: [['content-type', 'application/x-www-form-urlencoded'], ...credentials.headers],
    body: new URLSearchParams([['grant_type', 'authorization_code'], ['code', code], ['redirect_uri', redirectUri], ['code_verifier', grant.codeVerifier], ...credentials.fields]).toString(),
  });
  if (exchanged.response.status !== 200) throw new Error(`The OP did not exchange the code of the grant ${grant.id}: it answered ${exchanged.response.status} ${exchanged.text}`);
  return { ...prepared, tokens: JSON.parse(exchanged.text) as Record<string, unknown> };
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

/** Make the premises by requests (see the module comment and api.ts preparePremises). */
export async function preparePremises(premises: Premises): Promise<PreparedPremises> {
  const db = await configuredDatabase(premises);
  const key = await rs256Key('map-sandbox-rs256-key');
  const making: Making = { op: mapOp(db, key, premises.issuer), db, issuer: premises.issuer, steps: [] };
  const grants = await onDatabase(db, premises.now, async () => {
    const made: PreparedGrant[] = [];
    for (const grant of premises.grants) made.push(await runGrant(making, premises, grant));
    return made;
  });
  return {
    version: 1,
    issuer: premises.issuer,
    now: premises.now,
    steps: making.steps,
    records: recordsOf(making.steps, plainDatabase(db)),
    grants,
    database: encodeValue(db),
    signingKey: await exportSigningKey(key),
  };
}
