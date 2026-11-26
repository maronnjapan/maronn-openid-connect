import type { ExampleRequest } from './model.js';
import { deviceScenarios } from './scenarios/device.js';
import { interactionScenarios } from './scenarios/interaction.js';
import { protocolScenarios } from './scenarios/protocol.js';
import { tokenScenarios } from './scenarios/token.js';

/** A request a reader can generate for a protocol use case. */
export interface RequestScenario {
  id: string;
  endpoint: string;
  title: string;
  purpose: string;
  expected: { status: number; description: string; error?: string; redirectPath?: string };
  feature?: string;
  requires?: readonly string[];
  frameworks?: readonly string[];
  /** Setup required outside the live OP (packages/live-op): the build does not run such a case, and the tests viewer shows its request without sending it. */
  external?: string;
  nextjs?: { path?: string; expected?: RequestScenario['expected'] };
}

export interface AuthorizationScenarioOptions {
  issuer?: string;
  clientId?: string;
  redirectUri?: string;
  /** The registered ES256 signing key pair, or a fresh key pair for the example. */
  signingKey?: CryptoKeyPair;
}

/** The public coordinates and JOSE metadata of an ES256 verification key. */
export interface RequestObjectPublicKey {
  kty: 'EC';
  use: 'sig';
  alg: 'ES256';
  kid: string;
  crv: 'P-256';
  x: string;
  y: string;
}

/** Public client metadata for running the generated authorization request. */
export interface AuthorizationScenarioRegistration {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  request_object_signing_alg?: 'ES256';
  jwks?: { keys: RequestObjectPublicKey[] };
}

/** A generated request and the client settings relevant to its use. */
export interface GeneratedRequestScenario {
  request: ExampleRequest;
  url: string;
  /** The Unix clock used for the request's JWT claims. */
  issuedAt: number;
  codeVerifier?: string;
  registration?: AuthorizationScenarioRegistration;
}

export interface GeneratedAuthorizationScenario extends GeneratedRequestScenario {
  codeVerifier: string;
  registration: AuthorizationScenarioRegistration;
}

const EXPECT_LOGIN = { status: 302, description: '未ログインの場合はログイン画面へリダイレクト', redirectPath: '/login' };
const AUTHORIZE_SCENARIOS: readonly RequestScenario[] = [
  {
    id: 'authorize-code-pkce',
    endpoint: 'authorize',
    title: '認可コード + PKCE でログインを始める',
    purpose: '認可コードを受け取るため、S256 のコードチャレンジ付きで認可を開始する。',
    expected: EXPECT_LOGIN,
  },
  {
    id: 'authorize-request-object',
    endpoint: 'authorize',
    title: 'Request Object で認可をリクエストする',
    purpose: '認可パラメータを ES256 署名付き JWT にまとめ、登録した公開鍵で検証できるようにして送る。',
    expected: EXPECT_LOGIN,
    feature: 'request-object',
  },
  {
    id: 'authorize-prompt-none',
    endpoint: 'authorize',
    title: '画面を出さずにログイン状態を確認する',
    purpose: 'prompt=none を指定し、既存セッションを使えるか確認する。',
    expected: { status: 302, description: 'コールバックにログインが必要であることを返す', error: 'login_required' },
  },
];

export const REQUEST_SCENARIOS: readonly RequestScenario[] = [
  ...AUTHORIZE_SCENARIOS, ...protocolScenarios, ...interactionScenarios, ...tokenScenarios, ...deviceScenarios,
];

/** The feature IDs required by the case. */
export function requestScenarioFeatures(scenario: RequestScenario): readonly string[] {
  return scenario.feature === undefined ? (scenario.requires ?? []) : [scenario.feature, ...(scenario.requires ?? [])];
}

/** Match either the feature IDs or the camel-case markers of a framework. */
function featureKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Apply the framework's request path and response semantics to a case. */
function scenarioForFramework(scenario: RequestScenario, framework: string): RequestScenario | undefined {
  if (scenario.frameworks !== undefined && !scenario.frameworks.includes(framework)) return undefined;
  const expected = framework === 'nextjs' ? scenario.nextjs?.expected : undefined;
  return expected === undefined ? scenario : { ...scenario, expected };
}

/** The protocol use cases available at this endpoint in the selected provider. */
export function requestScenariosFor(endpointId: string, features?: readonly string[], framework = 'hono'): readonly RequestScenario[] {
  const available = features === undefined ? undefined : new Set(features.map(featureKey));
  return REQUEST_SCENARIOS.flatMap((scenario) => {
    if (scenario.endpoint !== endpointId || !requestScenarioFeatures(scenario).every((id) => available === undefined || available.has(featureKey(id)))) return [];
    const shown = scenarioForFramework(scenario, framework);
    return shown === undefined ? [] : [shown];
  });
}

/** Look up a case by its shareable ID. */
export function requestScenario(id: string, framework = 'hono'): RequestScenario | undefined {
  const scenario = REQUEST_SCENARIOS.find((candidate) => candidate.id === id);
  return scenario === undefined ? undefined : scenarioForFramework(scenario, framework);
}

/** Whether a case is generated with the browser-safe authorization request generator. */
export function isStandaloneAuthorizationScenario(id: string): boolean {
  return AUTHORIZE_SCENARIOS.some((scenario) => scenario.id === id);
}

const textEncoder = new TextEncoder();
const REQUEST_OBJECT_KEY_ID = 'request-scenario-key';

/** Encode bytes as an unpadded base64url value for PKCE or compact JWS. */
function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a fresh value for an authorization transaction. */
function randomValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Sign the authorization parameters as a compact ES256 Request Object. */
async function signRequestObject(options: { params: Record<string, string>; issuer: string; issuedAt: number; signingKey: CryptoKeyPair }): Promise<string> {
  const header = { alg: 'ES256', typ: 'oauth-authz-req+jwt', kid: REQUEST_OBJECT_KEY_ID };
  const claims = { ...options.params, iss: options.params.client_id, aud: options.issuer, iat: options.issuedAt, exp: options.issuedAt + 300, jti: randomValue() };
  const signingInput = `${base64Url(textEncoder.encode(JSON.stringify(header)))}.${base64Url(textEncoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, options.signingKey.privateKey, textEncoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** Generate the HTTP request and its public client configuration using the supplied provider settings. */
export async function generateRequestScenario(id: string, options: AuthorizationScenarioOptions = {}): Promise<GeneratedAuthorizationScenario> {
  if (!isStandaloneAuthorizationScenario(id)) throw new Error(`Unknown authorization request scenario: ${id}`);
  const issuer = options.issuer ?? 'https://op.example.com';
  const url = new URL(issuer);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`Invalid authorization issuer: ${issuer}`);
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/authorize`;
  const clientId = options.clientId ?? 'client-1';
  const redirectUri = options.redirectUri ?? 'https://rp.example.com/callback';
  const issuedAt = Math.floor(Date.now() / 1000);
  const codeVerifier = randomValue();
  const codeChallenge = await crypto.subtle.digest('SHA-256', textEncoder.encode(codeVerifier));
  const params = {
    client_id: clientId,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri,
    state: randomValue(),
    nonce: randomValue(),
    code_challenge: base64Url(new Uint8Array(codeChallenge)),
    code_challenge_method: 'S256',
  };
  const registration: AuthorizationScenarioRegistration = {
    client_id: clientId,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (id === 'authorize-request-object') {
    const signingKey = options.signingKey ?? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', signingKey.publicKey);
    if (kty !== 'EC' || crv !== 'P-256' || x === undefined || y === undefined) throw new Error('The Request Object signing key must be P-256.');
    const request = await signRequestObject({ params, issuer, issuedAt, signingKey });
    url.search = new URLSearchParams({ client_id: params.client_id, response_type: params.response_type, scope: params.scope, request }).toString();
    registration.request_object_signing_alg = 'ES256';
    registration.jwks = { keys: [{ kty, crv, x, y, kid: REQUEST_OBJECT_KEY_ID, alg: 'ES256', use: 'sig' }] };
  } else {
    url.search = new URLSearchParams(id === 'authorize-prompt-none' ? { ...params, prompt: 'none' } : params).toString();
  }
  return { request: { method: 'GET', path: `${url.pathname}${url.search}`, host: url.host, headers: [] }, url: url.href, issuedAt, codeVerifier, registration };
}

/** Format an HTTP request with its full encoded target, headers, and optional body. */
export function requestText(request: ExampleRequest): string {
  const headerLines = request.headers.map(([name, value]) => `${name}: ${value}`);
  if (!request.headers.some(([name]) => name.toLowerCase() === 'host')) headerLines.unshift(`Host: ${request.host}`);
  return [`${request.method} ${request.path} HTTP/1.1`, ...headerLines, '', request.body ?? ''].join('\r\n');
}
