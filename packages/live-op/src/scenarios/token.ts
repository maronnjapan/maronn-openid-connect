/**
 * The recipes of the cases of the token endpoint (the code, the refresh
 * token, client_credentials, client assertions, token exchange, ID-JAG)
 * and of the endpoints a token is sent to (UserInfo, introspection,
 * revocation), on the live OP. The codes and tokens they send are those the
 * grants of the case were issued, on real browser flows (grant.ts).
 */
import type { GrantPlan, GrantResult, LiveRequest } from '../api.js';
import { ASSERTION_KEY } from '../demo-keys.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';
import { clientForm, codeGrant, codeOf, get, jsonField, NOT_ISSUED, randomValue, requireStatus, signJwt, tokenOf, UNREGISTERED_CALLBACK, type ClientAuth } from './steps.js';

const CODE_CLIENT = 'client-1';
const POST_CLIENT = 'client-2';
const PUBLIC_CLIENT = 'public-client';
const SIGNED_USERINFO_CLIENT = 'signed-userinfo-client';
const SERVICE_CLIENT = 'service-1';
const PRIVATE_KEY_CLIENT = 'signed-assertion-client';
const CROSS_APP_CLIENT = 'xaa-client';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const ID_JAG_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The grant of a case: a code of a client for the case user (codeGrant), exchanged already or not. */
function withGrant(clientId: string, exchange: boolean, scope?: string): NonNullable<ScenarioRecipe['grants']> {
  return async (): Promise<GrantPlan[]> => [await codeGrant(clientId, exchange, scope)];
}

/** The grant the case ran first; the case stops without it. */
function grantOf(context: ScenarioContext): GrantResult {
  const grant = context.grants[0];
  if (grant === undefined) throw new Error('準備の認可を取得できませんでした。');
  return grant;
}

/** The token request that exchanges the code of the case's grant (RFC 6749 §4.1.3), as its client authenticates, with the changes given. */
function codeRequest(context: ScenarioContext, changes: Record<string, string> = {}): LiveRequest {
  const grant = grantOf(context);
  return clientForm(context, '/token', grant.clientId, {
    grant_type: 'authorization_code',
    code: codeOf(grant),
    redirect_uri: grant.redirectUri,
    ...(grant.codeVerifier === undefined ? {} : { code_verifier: grant.codeVerifier }),
    ...changes,
  });
}

/** The token request that refreshes the case's grant (RFC 6749 §6), for the scope given. */
function refreshRequest(context: ScenarioContext, scope?: string): LiveRequest {
  const grant = grantOf(context);
  return clientForm(context, '/token', grant.clientId, { grant_type: 'refresh_token', refresh_token: tokenOf(grant, 'refresh_token'), ...(scope === undefined ? {} : { scope }) });
}

/** A client_credentials request of a client (RFC 6749 §4.4), for reports.read unless the fields say otherwise. */
function serviceRequest(context: ScenarioContext, fields: Record<string, string> = {}, clientId = SERVICE_CLIENT, auth: ClientAuth = 'registered'): LiveRequest {
  return clientForm(context, '/token', clientId, { grant_type: 'client_credentials', scope: 'reports.read', ...fields }, auth);
}

/**
 * A client_credentials request of signed-assertion-client authenticated by
 * a JWT signed with its key (RFC 7523 §2.2, OIDC Core 1.0 §9), issued at
 * the OP's clock, or ten minutes before it, two minutes long, for the
 * expired case.
 */
async function privateKeyRequest(context: ScenarioContext, expired = false): Promise<LiveRequest> {
  const issuedAt = context.now() - (expired ? 600 : 0);
  const assertion = await signJwt({ alg: 'RS256', kid: ASSERTION_KEY.kid }, {
    iss: PRIVATE_KEY_CLIENT,
    sub: PRIVATE_KEY_CLIENT,
    aud: new URL('/token', context.issuer).href,
    iat: issuedAt,
    exp: issuedAt + 120,
    jti: randomValue(),
  }, ASSERTION_KEY.privateJwk);
  return clientForm(context, '/token', PRIVATE_KEY_CLIENT, { grant_type: 'client_credentials', scope: 'reports.read', client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }, 'id-only');
}

/** A token exchange request of a client (RFC 8693 §2.1) for a subject token, with the fields given. */
function exchangeRequest(context: ScenarioContext, subjectToken: string, fields: Record<string, string> = {}, clientId = SERVICE_CLIENT): LiveRequest {
  return clientForm(context, '/token', clientId, { grant_type: TOKEN_EXCHANGE, subject_token_type: ACCESS_TOKEN_TYPE, subject_token: subjectToken, ...fields });
}

/** A UserInfo request with an access token in the Authorization header (RFC 6750 §2.1), or none. */
function userinfo(token?: string, method: 'GET' | 'POST' = 'GET'): LiveRequest {
  const headers: LiveRequest['headers'] = token === undefined ? [] : [['authorization', `Bearer ${token}`]];
  return method === 'GET' ? get('/userinfo', headers) : { method: 'POST', path: '/userinfo', headers };
}

/** An introspection request of client-1 (RFC 7662 §2.1), with the token's type hinted or not, asking for a signed response (RFC 9701 §4) or not. */
function introspection(context: ScenarioContext, token: string, hint?: 'access_token' | 'refresh_token', signed = false): LiveRequest {
  return clientForm(context, '/introspect', CODE_CLIENT, { token, ...(hint === undefined ? {} : { token_type_hint: hint }) }, 'registered', signed ? [['accept', 'application/token-introspection+jwt']] : []);
}

/** A revocation request (RFC 7009 §2.1) of a client, authenticated as the case says. */
function revocation(context: ScenarioContext, token: string, hint: 'access_token' | 'refresh_token' = 'access_token', clientId = CODE_CLIENT, auth: ClientAuth = 'registered'): LiveRequest {
  return clientForm(context, '/revoke', clientId, { token, token_type_hint: hint }, auth);
}

/** The access token client_credentials gave service-1, sent as a step of the case. */
async function serviceToken(context: ScenarioContext): Promise<string> {
  return jsonField(requireStatus(await context.send(serviceRequest(context)), 200, 'サービスのトークン発行'), 'access_token');
}

export const tokenRecipes: Record<string, ScenarioRecipe> = {
  'token-authorization-code': { grants: withGrant(CODE_CLIENT, false, 'openid offline_access'), request: (context) => codeRequest(context) },
  'token-authorization-code-post-secret': { grants: withGrant(POST_CLIENT, false, 'openid offline_access'), request: (context) => codeRequest(context) },
  'token-authorization-code-public': { grants: withGrant(PUBLIC_CLIENT, false, 'openid offline_access'), request: (context) => codeRequest(context) },
  'token-authorization-code-used': { grants: withGrant(CODE_CLIENT, true), request: (context) => codeRequest(context) },
  'token-authorization-code-pkce-mismatch': {
    // The verifier of another PKCE pair than the one the authorization request was sent with.
    grants: withGrant(CODE_CLIENT, false, 'openid offline_access'),
    request: (context) => codeRequest(context, { code_verifier: `${randomValue()}${randomValue()}` }),
  },
  'token-authorization-code-redirect-mismatch': { grants: withGrant(CODE_CLIENT, false, 'openid offline_access'), request: (context) => codeRequest(context, { redirect_uri: UNREGISTERED_CALLBACK }) },
  'token-refresh': { grants: withGrant(CODE_CLIENT, true), request: (context) => refreshRequest(context) },
  'token-refresh-narrower-scope': { grants: withGrant(CODE_CLIENT, true), request: (context) => refreshRequest(context, 'openid') },
  'token-refresh-expanded-scope': { grants: withGrant(CODE_CLIENT, true), request: (context) => refreshRequest(context, 'openid email') },
  'token-refresh-reused': {
    grants: withGrant(CODE_CLIENT, true),
    async request(context) {
      const request = refreshRequest(context);
      requireStatus(await context.send(request), 200, 'リフレッシュトークンの更新');
      return request;
    },
  },
  'token-client-credentials': { request: (context) => serviceRequest(context) },
  'token-client-not-authorized': { request: (context) => serviceRequest(context, {}, CODE_CLIENT) },
  'token-client-credentials-scope-not-allowed': { request: (context) => serviceRequest(context, { scope: 'reports.delete' }) },
  'token-client-credentials-target-not-allowed': { request: (context) => serviceRequest(context, { audience: 'https://api.example.com' }) },
  'token-invalid-client-secret': { request: (context) => serviceRequest(context, {}, SERVICE_CLIENT, 'wrong-secret') },
  'token-private-key-client': { request: (context) => privateKeyRequest(context) },
  'token-private-key-client-expired': { request: (context) => privateKeyRequest(context, true) },
  'token-exchange': { grants: withGrant(CODE_CLIENT, true), request: (context) => exchangeRequest(context, tokenOf(grantOf(context), 'access_token'), { scope: 'openid' }) },
  'token-exchange-target-not-allowed': { grants: withGrant(CODE_CLIENT, true), request: (context) => exchangeRequest(context, tokenOf(grantOf(context), 'access_token'), { audience: 'https://api.example.com' }) },
  'token-exchange-unknown-subject': { request: (context) => exchangeRequest(context, NOT_ISSUED) },
  'token-id-jag-target-not-allowed': {
    grants: withGrant(CROSS_APP_CLIENT, true),
    request: (context) => exchangeRequest(context, tokenOf(grantOf(context), 'id_token'), {
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: ID_JAG_TYPE,
      audience: 'https://partner.example.com',
    }, CROSS_APP_CLIENT),
  },
  'token-id-jag-missing-assertion': { request: (context) => clientForm(context, '/token', CROSS_APP_CLIENT, { grant_type: JWT_BEARER }) },
  'token-unsupported-grant': { request: (context) => clientForm(context, '/token', CODE_CLIENT, { grant_type: 'unsupported_grant' }) },
  'token-missing-grant': { request: (context) => clientForm(context, '/token', CODE_CLIENT, {}) },

  'userinfo-bearer-get': { grants: withGrant(CODE_CLIENT, true), request: (context) => userinfo(tokenOf(grantOf(context), 'access_token')) },
  'userinfo-bearer-post': { grants: withGrant(CODE_CLIENT, true), request: (context) => userinfo(tokenOf(grantOf(context), 'access_token'), 'POST') },
  'userinfo-form-token': {
    grants: withGrant(CODE_CLIENT, true),
    request: (context) => ({ method: 'POST', path: '/userinfo', headers: [['content-type', 'application/x-www-form-urlencoded']], body: new URLSearchParams({ access_token: tokenOf(grantOf(context), 'access_token') }).toString() }),
  },
  'userinfo-signed-response': { grants: withGrant(SIGNED_USERINFO_CLIENT, true), request: (context) => userinfo(tokenOf(grantOf(context), 'access_token')) },
  'userinfo-without-token': { request: () => userinfo() },
  'userinfo-unknown-token': { request: () => userinfo(NOT_ISSUED) },
  'userinfo-id-token': { grants: withGrant(CODE_CLIENT, true), request: (context) => userinfo(tokenOf(grantOf(context), 'id_token')) },
  'userinfo-insufficient-scope': { request: async (context) => userinfo(await serviceToken(context)) },

  'introspection-active-access-token': { grants: withGrant(CODE_CLIENT, true), request: (context) => introspection(context, tokenOf(grantOf(context), 'access_token'), 'access_token') },
  'introspection-active-refresh-token': { grants: withGrant(CODE_CLIENT, true), request: (context) => introspection(context, tokenOf(grantOf(context), 'refresh_token'), 'refresh_token') },
  'introspection-signed-response': { grants: withGrant(CODE_CLIENT, true), request: (context) => introspection(context, tokenOf(grantOf(context), 'access_token'), undefined, true) },
  'introspection-unknown-token': { request: (context) => introspection(context, NOT_ISSUED) },
  'introspection-revoked-token': {
    grants: withGrant(CODE_CLIENT, true),
    async request(context) {
      const token = tokenOf(grantOf(context), 'access_token');
      requireStatus(await context.send(revocation(context, token)), 200, 'トークンの取り消し');
      return introspection(context, token);
    },
  },
  'introspection-public-client': {
    grants: withGrant(PUBLIC_CLIENT, true),
    request: (context) => clientForm(context, '/introspect', PUBLIC_CLIENT, { token: tokenOf(grantOf(context), 'access_token') }),
  },
  'introspection-missing-token': { request: (context) => clientForm(context, '/introspect', CODE_CLIENT, {}) },

  'revocation-access-token': { grants: withGrant(CODE_CLIENT, true), request: (context) => revocation(context, tokenOf(grantOf(context), 'access_token')) },
  'revocation-refresh-token': { grants: withGrant(CODE_CLIENT, true), request: (context) => revocation(context, tokenOf(grantOf(context), 'refresh_token'), 'refresh_token') },
  'revocation-public-client': { grants: withGrant(PUBLIC_CLIENT, true), request: (context) => revocation(context, tokenOf(grantOf(context), 'access_token'), 'access_token', PUBLIC_CLIENT) },
  'revocation-unknown-token': { request: (context) => revocation(context, NOT_ISSUED) },
  'revocation-other-client': { grants: withGrant(CODE_CLIENT, true), request: (context) => revocation(context, tokenOf(grantOf(context), 'access_token'), 'access_token', POST_CLIENT) },
  'revocation-invalid-client-secret': { grants: withGrant(CODE_CLIENT, true), request: (context) => revocation(context, tokenOf(grantOf(context), 'access_token'), 'access_token', CODE_CLIENT, 'wrong-secret') },
};
