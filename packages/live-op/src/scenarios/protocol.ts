/**
 * The recipes of the cases of the authorization request (standalone, PAR,
 * the response modes and types, prompt) and of dynamic client
 * registration, on the live OP.
 */
import type { LiveRequest } from '../api.js';
import { REQUEST_OBJECT_KEY } from '../demo-keys.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';
import { RP_CALLBACK } from '../seed.js';
import { authorizationQuery, clientForm, consentedBrowser, form, get, jsonField, randomValue, requireStatus, signedInBrowser, signJwt, UNREGISTERED_CALLBACK, type ClientAuth, type QueryChanges } from './steps.js';

/** The client of the code flow the cases send as (client_secret_basic). */
const CODE_CLIENT = 'client-1';

/** The authorization request of a client as a browser sends it, with the cookies given. */
function authorization(query: Record<string, string>, headers: LiveRequest['headers'] = []): LiveRequest {
  return get(`/authorize?${new URLSearchParams(query)}`, headers);
}

/** The authorization request of a client with fresh state, nonce and PKCE (authorizationQuery), with the changes given. */
async function freshAuthorization(clientId: string, changes: QueryChanges = {}, headers: LiveRequest['headers'] = []): Promise<LiveRequest> {
  return authorization((await authorizationQuery(clientId, changes)).query, headers);
}

/** The pushed authorization request of client-1 (RFC 9126 §2.1): its authorization parameters, authenticated as the client is registered or with a wrong secret. */
async function pushedRequest(context: ScenarioContext, { auth = 'registered', redirectUri = RP_CALLBACK }: { auth?: ClientAuth; redirectUri?: string } = {}): Promise<LiveRequest> {
  const { query } = await authorizationQuery(CODE_CLIENT, { redirect_uri: redirectUri });
  const { client_id: _clientId, ...fields } = query;
  return clientForm(context, '/par', CODE_CLIENT, fields, auth);
}

/** The public half of the demo key of request-object-client, as a client registers it (RFC 7591 §2 jwks). */
function requestObjectPublicKey(): Record<string, string> {
  const { kty, crv, x, y } = REQUEST_OBJECT_KEY.privateJwk;
  return { kty, crv, x, y, kid: REQUEST_OBJECT_KEY.kid, alg: 'ES256', use: 'sig' };
}

/** A registration request of a client with the metadata given (RFC 7591 §3.1), over a public client of the code flow. */
function register(metadata: Record<string, unknown> = {}): LiveRequest {
  return {
    method: 'POST',
    path: '/register',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      client_name: 'Request scenario client',
      redirect_uris: [RP_CALLBACK],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...metadata,
    }),
  };
}

/**
 * The authorization request of request-object-client with its parameters
 * in a Request Object signed with its ES256 key (OIDC Core 1.0 §6.1,
 * RFC 9101 §4), issued at the OP's clock.
 */
async function requestObjectAuthorization(context: ScenarioContext): Promise<LiveRequest> {
  const { query } = await authorizationQuery('request-object-client');
  const issuedAt = context.now();
  const request = await signJwt(
    { alg: 'ES256', typ: 'oauth-authz-req+jwt', kid: REQUEST_OBJECT_KEY.kid },
    { ...query, iss: query['client_id'], aud: context.issuer, iat: issuedAt, nbf: issuedAt, exp: issuedAt + 300, jti: randomValue() },
    REQUEST_OBJECT_KEY.privateJwk,
  );
  return authorization({ client_id: query['client_id'] ?? '', response_type: 'code', scope: 'openid', request });
}

export const protocolRecipes: Record<string, ScenarioRecipe> = {
  'authorize-code-pkce': { request: () => freshAuthorization('public-client') },
  'authorize-request-object': { request: requestObjectAuthorization },
  'authorize-prompt-none': { request: () => freshAuthorization('public-client', { prompt: 'none' }) },
  'authorize-post': {
    // The form is the client's page, posted by the browser to the OP.
    async request() {
      const { query } = await authorizationQuery(CODE_CLIENT);
      return form('/authorize', query, [['origin', new URL(RP_CALLBACK).origin]]);
    },
  },
  'authorize-par': {
    async request(context) {
      const pushed = requireStatus(await context.send(await pushedRequest(context)), 201, 'PAR');
      return authorization({ client_id: CODE_CLIENT, request_uri: jsonField(pushed, 'request_uri') });
    },
  },
  'authorize-par-unknown': { request: () => authorization({ client_id: CODE_CLIENT, request_uri: 'urn:ietf:params:oauth:request_uri:not-pushed-to-this-provider' }) },
  'authorize-form-post': { request: () => freshAuthorization(CODE_CLIENT, { response_mode: 'form_post' }) },
  'authorize-jarm': { request: () => freshAuthorization(CODE_CLIENT, { response_mode: 'query.jwt' }) },
  'authorize-implicit': {
    request: () => freshAuthorization('implicit-client', { response_type: 'id_token', code_challenge: undefined, code_challenge_method: undefined }),
  },
  'authorize-hybrid': { request: () => freshAuthorization('implicit-client', { response_type: 'code id_token' }) },
  'authorize-sso': {
    async request(context) {
      const { browser } = await consentedBrowser(context);
      return freshAuthorization(CODE_CLIENT, { prompt: 'none' }, browser.cookieHeaders());
    },
  },
  'authorize-silent-consent-required': {
    // A client registered just now, which the user has never consented to: the OP the cases share keeps every consent given before.
    async request(context) {
      const registered = requireStatus(await context.send(register({ client_name: 'Silent authorization client' })), 201, 'クライアント登録');
      const clientId = jsonField(registered, 'client_id');
      const { browser } = await signedInBrowser(context, clientId);
      return freshAuthorization(clientId, { prompt: 'none', scope: 'openid profile' }, browser.cookieHeaders());
    },
  },
  'authorize-force-login': {
    async request(context) {
      const { browser } = await consentedBrowser(context);
      return freshAuthorization(CODE_CLIENT, { prompt: 'login' }, browser.cookieHeaders());
    },
  },
  'authorize-force-consent': {
    async request(context) {
      const { browser } = await consentedBrowser(context);
      return freshAuthorization(CODE_CLIENT, { prompt: 'consent' }, browser.cookieHeaders());
    },
  },
  'authorize-unknown-client': { request: () => freshAuthorization('client-not-registered-with-this-provider') },
  'authorize-unregistered-redirect': { request: () => freshAuthorization(CODE_CLIENT, { redirect_uri: UNREGISTERED_CALLBACK }) },
  'authorize-missing-scope': { request: () => freshAuthorization(CODE_CLIENT, { scope: undefined }) },
  'par-push-code-pkce': { request: (context) => pushedRequest(context) },
  'par-invalid-client': { request: (context) => pushedRequest(context, { auth: 'wrong-secret' }) },
  'par-invalid-redirect': { request: (context) => pushedRequest(context, { redirectUri: UNREGISTERED_CALLBACK }) },
  'register-public-code-client': { request: () => register() },
  'register-confidential-client': { request: () => register({ token_endpoint_auth_method: 'client_secret_basic' }) },
  'register-request-object-client': { request: () => register({ jwks: { keys: [requestObjectPublicKey()] }, request_object_signing_alg: 'ES256' }) },
  'register-invalid-redirect': { request: () => register({ redirect_uris: ['/callback'] }) },
  'register-invalid-metadata': { request: () => register({ grant_types: ['unsupported-grant'] }) },
};

