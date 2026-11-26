/**
 * An authorization run on a workspace the way it comes about: a browser of
 * its own sends the client's authorization request, follows the OP's
 * redirects to its own pages, and submits the form of each page as the user
 * would (the login form with the user's name and password, the consent
 * approved), up to the redirect back to the client with a code (or the form
 * posting it back, for response_mode=form_post); with `exchange`, the
 * client then sends the code to the token endpoint with its credentials,
 * the way it is registered to send them. Every request is an exchange of
 * the workspace, like any other.
 */
import type { ExchangeSource, ExchangeSummary, GrantPlan, GrantResult, LiveClient, LiveRequest } from './api.js';
import { cookieHeaders, keepCookies, submittedForm, type CookieJar } from './browser.js';
import { liveClient, LIVE_USERS } from './seed.js';
import type { LiveWorkspace } from './workspace.js';

/** The most requests a browser sends after the authorization request before it gives up: login page, login, consent page, consent, and some to spare. */
const MOST_PAGES = 8;

/** A response as a step of a case or a grant reads it: its status, its headers (every Set-Cookie on a line), its body as text, the URL it answered. */
export interface StepResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
  url: string;
  exchange: ExchangeSummary;
}

/** Send a request to a workspace as a step of a case or a grant, and read the whole response. */
export async function sendStep(workspace: LiveWorkspace, request: LiveRequest, source: ExchangeSource, scenario?: string): Promise<StepResponse> {
  const { response, exchange } = await workspace.send(request, source, scenario);
  const headers: Array<[string, string]> = [];
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers.push([name, value]);
  for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie]);
  const { request: _request, response: _response, trace: _trace, store: _store, thrown: _thrown, ...summary } = exchange;
  return { status: response.status, headers, body: await response.text(), url: exchange.request.url, exchange: summary };
}

/** The value of a header of a step's response; undefined without it. */
export function headerOf(response: Pick<StepResponse, 'headers'>, name: string): string | undefined {
  return response.headers.find(([candidate]) => candidate === name)?.[1];
}

/** The headers and the fields a client authenticates with at the token endpoint, the way it is registered (RFC 6749 §2.3.1: in the Authorization header, or in the body with its secret; a public client by its id alone). */
export function clientCredentials(client: LiveClient): { headers: Array<[string, string]>; fields: Array<[string, string]> } {
  const secret = client.clientSecret ?? '';
  if (client.authMethod === 'client_secret_basic') return { headers: [['authorization', `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`)}`]], fields: [] };
  if (client.authMethod === 'client_secret_post') return { headers: [], fields: [['client_id', client.clientId], ['client_secret', secret]] };
  return { headers: [], fields: [['client_id', client.clientId]] };
}

/**
 * The code the OP gave the client: in the query of the redirect to its
 * redirect_uri, in the fragment of it, or among the fields of the form the
 * OP's page posts to it (response_mode=form_post); undefined when the
 * response is none of these.
 */
function codeOf(response: StepResponse, issuer: string, redirectUri: string, user: { username: string; password: string }): string | undefined {
  const location = headerOf(response, 'location');
  if (location !== undefined) {
    const back = new URL(location, issuer);
    if (`${back.origin}${back.pathname}` !== redirectUri) return undefined;
    return back.searchParams.get('code') ?? new URLSearchParams(back.hash.slice(1)).get('code') ?? undefined;
  }
  const form = response.status === 200 ? submittedForm(response.body, user) : undefined;
  return form?.action === redirectUri ? form.fields.find(([name]) => name === 'code')?.[1] : undefined;
}

/** A browser on the OP's pages: its cookies, and the user it signs in as. */
export interface Browser {
  cookies: CookieJar;
  user: { username: string; password: string };
}

/** Send a request as a browser does (its cookies, and the Origin of a form posted from the OP's page), keeping the cookies the response sets. */
export async function browse(workspace: LiveWorkspace, browser: Browser, method: string, path: string, init: { body?: string; source: ExchangeSource; scenario?: string }): Promise<StepResponse> {
  const origin = new URL(workspace.issuer).origin;
  const headers: Array<[string, string]> = method === 'POST' ? [['content-type', 'application/x-www-form-urlencoded'], ['origin', origin]] : [];
  headers.push(...cookieHeaders(browser.cookies));
  const response = await sendStep(workspace, { method, path, headers, ...(init.body === undefined ? {} : { body: init.body }) }, init.source, init.scenario);
  keepCookies(browser.cookies, response.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value));
  return response;
}

/** The path and query of a URL of the OP, or undefined for a URL elsewhere. */
function pathOnOp(url: string, issuer: string): string | undefined {
  const target = new URL(url, issuer);
  return target.origin === new URL(issuer).origin ? `${target.pathname}${target.search}` : undefined;
}

/**
 * Run a grant on a workspace (see the module comment): what it left, and
 * the exchanges it sent. The browser it signed in with is given back too,
 * for a case that goes on with the user's session.
 */
export async function runGrant(workspace: LiveWorkspace, plan: GrantPlan, source: ExchangeSource = 'grant', scenario?: string): Promise<GrantResult & { browser: Browser }> {
  const user = LIVE_USERS.find((candidate) => candidate.username === plan.username);
  const clientId = plan.authorize['client_id'] ?? '';
  const client = liveClient(workspace.issuer, clientId);
  const redirectUri = plan.authorize['redirect_uri'] ?? '';
  if (user === undefined || client === undefined) throw new Error(`The live OP has no user ${plan.username} or no client ${clientId}.`);
  const browser: Browser = { cookies: new Map(), user };
  const steps: ExchangeSummary[] = [];
  const step = async (method: string, path: string, body?: string): Promise<StepResponse> => {
    const response = await browse(workspace, browser, method, path, { source, ...(scenario === undefined ? {} : { scenario }), ...(body === undefined ? {} : { body }) });
    steps.push(response.exchange);
    return response;
  };
  let response = await step('GET', `/authorize?${new URLSearchParams(plan.authorize)}`);
  // The browser stays on the OP: it follows a redirect to the OP's pages and submits a form that posts to the OP; a redirect or a form to the client ends it.
  for (let page = 0; page < MOST_PAGES; page += 1) {
    const location = headerOf(response, 'location');
    const form = response.status === 200 ? submittedForm(response.body, user) : undefined;
    const next = location === undefined ? undefined : pathOnOp(location, workspace.issuer);
    const action = form === undefined ? undefined : pathOnOp(form.action, workspace.issuer);
    if (next !== undefined) response = await step('GET', next);
    else if (form !== undefined && action !== undefined) response = await step('POST', action, new URLSearchParams(form.fields).toString());
    else break;
  }
  const code = codeOf(response, workspace.issuer, redirectUri, user);
  const base = { clientId, redirectUri, ...(plan.codeVerifier === undefined ? {} : { codeVerifier: plan.codeVerifier }), browser };
  if (code === undefined) return { ...base, failure: `The OP gave no code: it answered ${response.status} ${headerOf(response, 'location') ?? ''}`.trim(), steps };
  if (!plan.exchange) return { ...base, code, steps };
  const credentials = clientCredentials(client);
  const exchanged = await sendStep(workspace, {
    method: 'POST',
    path: '/token',
    headers: [['content-type', 'application/x-www-form-urlencoded'], ...credentials.headers],
    body: new URLSearchParams([['grant_type', 'authorization_code'], ['code', code], ['redirect_uri', redirectUri], ...(plan.codeVerifier === undefined ? [] : [['code_verifier', plan.codeVerifier] as [string, string]]), ...credentials.fields]).toString(),
  }, source, scenario);
  steps.push(exchanged.exchange);
  if (exchanged.status !== 200) return { ...base, code, failure: `The OP did not exchange the code: it answered ${exchanged.status} ${exchanged.body}`, steps };
  return { ...base, code, tokens: JSON.parse(exchanged.body) as Record<string, unknown>, steps };
}

/** A new PKCE verifier and its S256 challenge (RFC 7636 §4.1, §4.2). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
}

/** Bytes as base64url without padding. */
export function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
