/**
 * What the recipes of the cases share: requests written as a client or a
 * browser sends them, a browser that keeps the OP's cookies from one step
 * to the next, the authorization requests of the seeded clients with fresh
 * state, nonce and PKCE, and JWTs signed with the demo keys of the clients
 * that sign (demo-keys.ts). Every value a step reads comes from the OP's
 * responses or from what a client is configured with (seed.ts).
 */
import type { GrantPlan, GrantResult, LiveRequest, LiveUser } from '../api.js';
import { cookieHeaders, keepCookies, submittedForm, type CookieJar } from '../browser.js';
import { base64Url, clientCredentials, headerOf, pkcePair, type StepResponse } from '../grant.js';
import type { ScenarioContext } from '../scenario-runtime.js';
import { liveClient, LIVE_USERS, RP_CALLBACK } from '../seed.js';

/** The content type of a form a client or a browser posts. */
export const FORM_TYPE: [string, string] = ['content-type', 'application/x-www-form-urlencoded'];

/** The user the cases sign in as (a development user of apps/hono). */
export const CASE_USER = LIVE_USERS[0] as LiveUser;

/** A redirect URI no client of the live OP registers. */
export const UNREGISTERED_CALLBACK = 'https://rp.example.com/other-callback';

/** A value no OP issued, for the cases about a token or a code the OP does not know. */
export const NOT_ISSUED = 'token-not-issued-by-this-provider';

/** A GET with the headers given. */
export function get(path: string, headers: LiveRequest['headers'] = []): LiveRequest {
  return { method: 'GET', path, headers };
}

/** The fields of a form, in order. */
type Fields = URLSearchParams | Array<[string, string]> | Record<string, string>;

/** A form POST with the fields and the headers given. */
export function form(path: string, fields: Fields, headers: LiveRequest['headers'] = []): LiveRequest {
  const body = new URLSearchParams(fields instanceof URLSearchParams || Array.isArray(fields) ? [...fields] : Object.entries(fields));
  return { method: 'POST', path, headers: [FORM_TYPE, ...headers], body: body.toString() };
}

/**
 * How a client authenticates a request of a case: as it is registered
 * (`registered`), with a secret it was not given (`wrong-secret`, in the
 * way it is registered to send one), or by its id alone (`id-only`).
 */
export type ClientAuth = 'registered' | 'wrong-secret' | 'id-only';

/** A form POST of a client to an endpoint of the OP, authenticated as the client is configured with the live OP (seed.ts). */
export function clientForm(context: Pick<ScenarioContext, 'issuer'>, path: string, clientId: string, fields: Record<string, string>, auth: ClientAuth = 'registered', headers: LiveRequest['headers'] = []): LiveRequest {
  const client = liveClient(context.issuer, clientId);
  if (client === undefined) throw new Error(`ライブ OP にクライアント ${clientId} が登録されていません。`);
  const credentials = auth === 'id-only'
    ? { headers: [], fields: [['client_id', clientId] as [string, string]] }
    : clientCredentials(auth === 'wrong-secret' ? { ...client, clientSecret: `${client.clientSecret ?? ''}-wrong` } : client);
  return form(path, [...Object.entries(fields), ...credentials.fields], [...credentials.headers, ...headers]);
}

/** Stop a case whose step the OP did not answer as the case needs. */
export function requireStatus(response: StepResponse, status: number, what: string): StepResponse {
  if (response.status !== status) {
    throw new Error(`${what}: OP は HTTP ${response.status} を返しました（期待は ${status}）。${response.body.slice(0, 200)}`);
  }
  return response;
}

/** A string member of the JSON body of a step's response; the case stops without it. */
export function jsonField(response: StepResponse, name: string): string {
  let value: unknown;
  try {
    value = (JSON.parse(response.body) as Record<string, unknown>)[name];
  } catch {
    value = undefined;
  }
  if (typeof value !== 'string' || value === '') throw new Error(`OP の応答（${new URL(response.url).pathname}）に ${name} がありません。`);
  return value;
}

/** A token the grant of a case was issued; the case stops without it. */
export function tokenOf(grant: GrantResult | undefined, type: 'access_token' | 'refresh_token' | 'id_token'): string {
  const value = grant?.tokens?.[type];
  if (typeof value !== 'string') throw new Error(`準備の認可から ${type} を取得できませんでした。`);
  return value;
}

/** The code the grant of a case was given; the case stops without it. */
export function codeOf(grant: GrantResult | undefined): string {
  if (grant?.code === undefined) throw new Error('準備の認可から認可コードを取得できませんでした。');
  return grant.code;
}

/** A fresh random value for state, nonce or jti. */
export function randomValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Changes to the parameters of an authorization request: a value to set, or undefined to leave the parameter out. */
export type QueryChanges = Record<string, string | undefined>;

/**
 * The query of an authorization request of a seeded client: the code flow
 * with a fresh state, nonce and PKCE pair (S256), to RP_CALLBACK, for the
 * scope given (with offline_access, prompt=consent too, without which the
 * OP drops offline_access: OIDC Core 1.0 §11), with the changes given (a
 * parameter changed to undefined is left out); and the PKCE verifier.
 */
export async function authorizationQuery(clientId: string, changes: QueryChanges = {}, scope = 'openid'): Promise<{ query: Record<string, string>; codeVerifier: string }> {
  const pkce = await pkcePair();
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RP_CALLBACK,
    scope,
    state: randomValue(),
    nonce: randomValue(),
    ...(scope.split(' ').includes('offline_access') ? { prompt: 'consent' } : {}),
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete query[name];
    else query[name] = value;
  }
  return { query, codeVerifier: pkce.verifier };
}

/** A grant of a seeded client for the case user (see authorizationQuery), its code exchanged at the token endpoint or not. */
export async function codeGrant(clientId: string, exchange: boolean, scope = 'openid profile offline_access'): Promise<GrantPlan> {
  const { query, codeVerifier } = await authorizationQuery(clientId, {}, scope);
  return { authorize: query, codeVerifier, username: CASE_USER.username, exchange };
}

/** A browser of a case on the OP's pages: the cookies the OP set it, and the user it signs in as. */
export class CaseBrowser {
  readonly cookies: CookieJar = new Map();

  constructor(
    private readonly context: ScenarioContext,
    readonly user: { username: string; password: string } = CASE_USER,
  ) {}

  /** The Cookie header the browser sends with its next request. */
  cookieHeaders(): LiveRequest['headers'] {
    return cookieHeaders(this.cookies);
  }

  /** A GET the browser sends, with its cookies. */
  get(path: string): LiveRequest {
    return get(path, this.cookieHeaders());
  }

  /** A form the browser posts from a page of the OP: its Origin and its cookies. */
  post(path: string, fields: Fields): LiveRequest {
    return form(path, fields, [['origin', new URL(this.context.issuer).origin], ...this.cookieHeaders()]);
  }

  /** Send a request as a step of the case, keep the cookies its response sets, and stop the case unless the OP answers the status given. */
  async send(request: LiveRequest, status: number, what: string): Promise<StepResponse> {
    const response = await this.context.send(request);
    keepCookies(this.cookies, response.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value));
    return requireStatus(response, status, what);
  }

  /** The path and query of the OP's page a response redirects the browser to; the case stops unless it is the page given. */
  pageOf(response: StepResponse, pathname: string): string {
    const location = headerOf(response, 'location');
    const target = location === undefined ? undefined : new URL(location, response.url);
    if (target === undefined || target.origin !== new URL(this.context.issuer).origin || target.pathname !== pathname) {
      throw new Error(`OP は ${pathname} へリダイレクトしませんでした（Location: ${location ?? 'なし'}）。`);
    }
    return `${target.pathname}${target.search}`;
  }

  /**
   * The form of an OP's page as the user submits it, as a request the
   * browser posts: the hidden fields as the page has them, the user's name
   * and password, the approving button, with the changes given. The case
   * stops if the page has no form posting to the OP.
   */
  formOf(page: StepResponse, changes: Record<string, string> = {}): LiveRequest {
    const submitted = submittedForm(page.body, this.user);
    const action = submitted === undefined ? undefined : new URL(submitted.action, this.context.issuer);
    if (submitted === undefined || action === undefined || action.origin !== new URL(this.context.issuer).origin) {
      throw new Error(`${new URL(page.url).pathname} に OP へ送信するフォームがありません。`);
    }
    const fields = new URLSearchParams(submitted.fields);
    for (const [name, value] of Object.entries(changes)) fields.set(name, value);
    return this.post(`${action.pathname}${action.search}`, fields);
  }

  /** Open a page of the OP and give the request that submits its form (formOf). */
  async submitPage(path: string, changes: Record<string, string> = {}, what = path): Promise<LiveRequest> {
    return this.formOf(await this.send(this.get(path), 200, what), changes);
  }
}

/**
 * A browser that started an authorization of a seeded client (the code
 * flow of authorizationQuery with prompt=consent, for openid and profile,
 * with the changes given) and was sent to the login page: the browser, the
 * path of its login page, and the verifier of the request's PKCE.
 */
export async function beginLogin(context: ScenarioContext, clientId = 'client-1', changes: QueryChanges = {}): Promise<{ browser: CaseBrowser; login: string; codeVerifier: string }> {
  const browser = new CaseBrowser(context);
  const { query, codeVerifier } = await authorizationQuery(clientId, { prompt: 'consent', ...changes }, 'openid profile');
  const started = await browser.send(browser.get(`/authorize?${new URLSearchParams(query)}`), 302, '認可リクエスト');
  return { browser, login: browser.pageOf(started, '/login'), codeVerifier };
}

/** A browser that started an authorization (beginLogin) and signed in at the login page: the browser, the path of its consent page, and the PKCE verifier. */
export async function signedInBrowser(context: ScenarioContext, clientId = 'client-1', changes: QueryChanges = {}): Promise<{ browser: CaseBrowser; consent: string; codeVerifier: string }> {
  const { browser, login, codeVerifier } = await beginLogin(context, clientId, changes);
  const signedIn = await browser.send(await browser.submitPage(login, {}, 'ログイン画面'), 302, 'ログイン');
  return { browser, consent: browser.pageOf(signedIn, '/consent'), codeVerifier };
}

/** A browser that signed in (signedInBrowser) and approved the consent page: the browser, the OP's response to the approval, and the PKCE verifier. */
export async function consentedBrowser(context: ScenarioContext, clientId = 'client-1', changes: QueryChanges = {}): Promise<{ browser: CaseBrowser; approved: StepResponse; codeVerifier: string }> {
  const { browser, consent, codeVerifier } = await signedInBrowser(context, clientId, changes);
  const approved = await browser.send(await browser.submitPage(consent, {}, '同意画面'), 302, '同意');
  return { browser, approved, codeVerifier };
}

/** How WebCrypto imports a demo key of each algorithm, and signs with it (RFC 7518 §3.3, §3.4). */
const ALGORITHMS = {
  RS256: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { key: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
} as const;

/** A compact JWS of claims, signed with a private JWK of a demo client (RFC 7515 §7.1). */
export async function signJwt(header: { alg: keyof typeof ALGORITHMS; kid: string; typ?: string }, claims: Record<string, unknown>, privateJwk: Readonly<Record<string, string>>): Promise<string> {
  const algorithm = ALGORITHMS[header.alg];
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk } as JsonWebKey, algorithm.key, false, ['sign']);
  const encoder = new TextEncoder();
  const input = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(algorithm.sign, key, encoder.encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}
