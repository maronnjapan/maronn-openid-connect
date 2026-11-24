import type { SandboxRequest } from '../api.js';
import { cookieHeaders, keepCookies, submittedForm, type CookieJar } from '../browser-session.js';
import { PREMISES } from '../premises.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';

type ScenarioResponse = Awaited<ReturnType<ScenarioContext['send']>>;
type Browser = { context: ScenarioContext; cookies: CookieJar };

const grant = PREMISES.grants[0];
const user = PREMISES.users[0];
const client = PREMISES.clients[0];
const formType: [string, string] = ['content-type', 'application/x-www-form-urlencoded'];

/** Make the browser's next GET request. */
function get(path: string, browser?: Browser): SandboxRequest {
  return { method: 'GET', path, headers: browser === undefined ? [] : cookieHeaders(browser.cookies) };
}

/** Preserve the submitted form, origin and session cookies. */
function post(path: string, fields: URLSearchParams, browser: Browser): SandboxRequest {
  return {
    method: 'POST',
    path,
    headers: [formType, ['origin', new URL(browser.context.issuer).origin], ...cookieHeaders(browser.cookies)],
    body: fields.toString(),
  };
}

/** Run one preparatory request and keep the response's cookies. */
async function send(browser: Browser, request: SandboxRequest, status: number): Promise<ScenarioResponse> {
  const response = await browser.context.send(request);
  if (response.status !== status) throw new Error(`${request.method} ${new URL(request.path, browser.context.issuer).pathname}: HTTP ${response.status}、期待は ${status}`);
  keepCookies(browser.cookies, response.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value));
  return response;
}

/** Read the next location that the flow actually returned. */
function locationOf(response: ScenarioResponse): URL {
  const location = response.headers.find(([name]) => name === 'location')?.[1];
  if (location === undefined) throw new Error('セットアップの応答に Location がありません');
  return new URL(location, response.url);
}

/** Read the OP's local redirect, preserving its transaction query. */
function localPath(response: ScenarioResponse, expected: string): string {
  const target = locationOf(response);
  if (target.origin !== new URL(response.url).origin || target.pathname !== expected) throw new Error(`セットアップのリダイレクト先が ${expected} ではありません`);
  return target.pathname + target.search;
}

/** Submit fields from the provider's form with the browser's session. */
async function renderedForm(browser: Browser, path: string, override: Record<string, string> = {}): Promise<SandboxRequest> {
  const page = await send(browser, get(path, browser), 200);
  const form = submittedForm(page.body, user);
  if (form === undefined) throw new Error(`${path} に送信フォームがありません`);
  const action = new URL(form.action, browser.context.issuer);
  if (action.origin !== new URL(browser.context.issuer).origin) throw new Error('セットアップのフォーム送信先が OP の外です');
  const fields = new URLSearchParams(form.fields);
  for (const [name, value] of Object.entries(override)) fields.set(name, value);
  return post(action.pathname + action.search, fields, browser);
}

/** Start an authorization transaction and return the browser's login URL. */
async function beginLogin(context: ScenarioContext, options: Record<string, string> = {}) {
  const browser: Browser = { context, cookies: new Map() };
  const authorize = { ...grant.authorize, scope: 'openid profile', prompt: 'consent', ...options };
  const response = await send(browser, get(`/authorize?${new URLSearchParams(authorize)}`, browser), 302);
  return { browser, login: localPath(response, '/login') };
}

/** Sign in through the rendered form and return the consent URL and its browser session. */
export async function signedInBrowser(context: ScenarioContext, options: Record<string, string> = {}) {
  const { browser, login } = await beginLogin(context, options);
  const signedIn = await send(browser, await renderedForm(browser, login), 302);
  return { browser, consent: localPath(signedIn, '/consent') };
}

/** Open the browser's login form and prepare the selected credential submission. */
async function submitCredentials(context: ScenarioContext, fields: Record<string, string> = {}) {
  const { browser, login } = await beginLogin(context);
  return { browser, request: await renderedForm(browser, login, fields) };
}

/** Prepare a consent submission after the browser signs in. */
async function consentRequest(context: ScenarioContext, action: string, authorization?: Record<string, string>): Promise<SandboxRequest> {
  const { browser, consent } = await signedInBrowser(context, authorization);
  return renderedForm(browser, consent, { action });
}

/** Register the browser client for cases that issue tokens from the authorization endpoint. */
function withAuthorizationTokens(now: number) {
  return {
    ...PREMISES, now, grants: [],
    clients: [{ ...client, grantTypes: [...client.grantTypes, 'implicit'], responseTypes: ['code', 'id_token', 'code id_token'] }],
  };
}

/** Sign in and approve the requested scopes in the browser. */
export async function consentedBrowser(context: ScenarioContext) {
  const { browser, consent } = await signedInBrowser(context);
  const approved = await send(browser, await renderedForm(browser, consent), 302);
  return { browser, approved };
}

/** Obtain an ID token for a browser through the consent and token endpoints. */
async function idTokenForLogout(context: ScenarioContext) {
  const { browser, approved } = await consentedBrowser(context);
  const code = locationOf(approved).searchParams.get('code');
  if (code === null) throw new Error('同意の応答に認可コードがありません');
  const fields = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: grant.authorize.redirect_uri,
    code_verifier: grant.codeVerifier,
  });
  const exchanged = await context.send({
    method: 'POST',
    path: '/token',
    headers: [formType, ['authorization', `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`]],
    body: fields.toString(),
  });
  if (exchanged.status !== 200) throw new Error(`ID トークンの取得に失敗しました（HTTP ${exchanged.status}）`);
  const idToken = (JSON.parse(exchanged.body) as { id_token?: unknown }).id_token;
  if (typeof idToken !== 'string') throw new Error('トークン応答に ID トークンがありません');
  return { browser, idToken };
}

export const interactionRecipes: Record<string, ScenarioRecipe> = {
  'discovery-provider-metadata': { request: () => ({ ...get('/.well-known/openid-configuration'), headers: [['accept', 'application/json']] }) },
  'jwks-verify-signature': { request: () => ({ ...get('/.well-known/jwks.json'), headers: [['accept', 'application/json']] }) },
  'login-open-transaction': {
    async request(context) {
      const { browser, login } = await beginLogin(context);
      return get(login, browser);
    },
  },
  'login-without-transaction': { request: () => get('/login') },
  'login-submit-password': { request: async (context) => (await submitCredentials(context)).request },
  'login-retry-password': { request: async (context) => (await submitCredentials(context, { password: 'wrong-demo-password' })).request },
  'login-expired-form': { request: async (context) => (await submitCredentials(context, { csrf_token: 'stale-form-token' })).request },
  'login-attempts-exhausted': {
    async request(context) {
      const { browser, request } = await submitCredentials(context, { password: 'wrong-demo-password' });
      for (let attempt = 0; attempt < 4; attempt += 1) await send(browser, request, 200);
      return request;
    },
  },
  'login-google-complete': {
    request: () => ({
      method: 'POST',
      path: '/login/google',
      headers: [formType, ['cookie', 'g_csrf_token={google_csrf_token}']],
      body: new URLSearchParams({ credential: '{google_id_token}', g_csrf_token: '{google_csrf_token}' }).toString(),
    }),
  },
  'login-google-disabled': {
    request: () => ({ method: 'POST', path: '/login/google', headers: [formType], body: '' }),
  },
  'consent-open': {
    async request(context) {
      const { browser, consent } = await signedInBrowser(context);
      return get(consent, browser);
    },
  },
  'consent-without-transaction': { request: () => get('/consent') },
  'consent-approve-code': { request: (context) => consentRequest(context, 'approve') },
  'consent-deny': { request: (context) => consentRequest(context, 'deny') },
  'consent-require-decision': { request: (context) => consentRequest(context, '') },
  'consent-require-login': {
    async request(context) {
      const { browser, login } = await beginLogin(context);
      const { search } = new URL(login, context.issuer);
      return renderedForm(browser, `/consent${search}`);
    },
  },
  'consent-approve-form-post': { request: (context) => consentRequest(context, 'approve', { response_mode: 'form_post' }) },
  'consent-approve-jarm': { request: (context) => consentRequest(context, 'approve', { response_mode: 'query.jwt' }) },
  'consent-approve-implicit': {
    plan: withAuthorizationTokens,
    request: (context) => consentRequest(context, 'approve', { response_type: 'id_token' }),
  },
  'consent-approve-hybrid': {
    plan: withAuthorizationTokens,
    request: (context) => consentRequest(context, 'approve', { response_type: 'code id_token' }),
  },
  'logout-show-confirmation': {
    async request(context) {
      const { browser } = await signedInBrowser(context);
      return get('/logout', browser);
    },
  },
  'logout-confirm': {
    async request(context) {
      const { browser } = await signedInBrowser(context);
      return renderedForm(browser, '/logout');
    },
  },
  'logout-approval-expired': {
    async request(context) {
      const { browser } = await signedInBrowser(context);
      return post('/logout/approve', new URLSearchParams(), browser);
    },
  },
  'logout-use-id-token-hint': {
    async request(context) {
      const { browser, idToken } = await idTokenForLogout(context);
      return post('/logout', new URLSearchParams({ id_token_hint: idToken }), browser);
    },
  },
  'logout-registered-redirect': {
    plan: (now) => ({ ...PREMISES, now, grants: [], postLogoutRedirectUris: { [client.clientId]: ['https://rp.example.com/bye'] } }),
    async request(context) {
      const { browser, idToken } = await idTokenForLogout(context);
      return get(`/logout?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: 'https://rp.example.com/bye', state: 'logout-state' })}`, browser);
    },
  },
};
