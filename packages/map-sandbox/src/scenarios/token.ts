import { rs256Key } from '../../../../apps/hono/src/test-support/keys.js';
import { signJwt } from '@maronn-openid-connect/core';
import type { PreparedGrant, SandboxRequest } from '../api.js';
import { PREMISES } from '../premises.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';

const CODE_CLIENT = 'client-1';
const POST_CLIENT = 'client-2';
const SERVICE_CLIENT = 'service-1';
const PRIVATE_KEY_CLIENT = 'signed-assertion-client';
const ASSERTION_KEY_ID = 'request-case-client-assertion';
const NO_TOKEN = 'token-not-issued-by-this-provider';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const ID_JAG_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const PKCE_OTHER_VERIFIER = 'wrong-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';

/** Set up the grants for the request being demonstrated. */
function withGrant(id: 'unused' | 'exchanged', mode?: 'public' | 'post' | 'signed-userinfo' | 'id-jag'): NonNullable<ScenarioRecipe['plan']> {
  return (now) => ({
    ...PREMISES,
    now,
    clients: mode === 'public'
      ? PREMISES.clients.map((client) => client.clientId === CODE_CLIENT ? { ...client, clientSecret: undefined, authMethod: 'none' } : client)
      : PREMISES.clients.map((client) => {
        if (client.clientId !== CODE_CLIENT) return client;
        if (mode === 'signed-userinfo') return { ...client, userinfoSignedResponseAlg: 'RS256' };
        if (mode === 'id-jag') return { ...client, grantTypes: [...client.grantTypes, TOKEN_EXCHANGE] };
        return client;
      }),
    grants: PREMISES.grants.filter((grant) => grant.id === id).map((grant) => (
      mode === 'post' ? { ...grant, authorize: { ...grant.authorize, client_id: POST_CLIENT } } : grant
    )),
  });
}

/** Retrieve the code or tokens issued when the sandbox prepared the grant. */
function grantOf(context: ScenarioContext): PreparedGrant {
  const grant = context.grants[0];
  if (grant === undefined) throw new Error('準備の認可リクエストから認可コードを取得できませんでした。');
  return grant;
}

/** Retrieve an actually issued token, never substitute an example string. */
function tokenOf(context: ScenarioContext, type: 'access_token' | 'refresh_token' | 'id_token'): string {
  const value = grantOf(context).tokens?.[type];
  if (typeof value !== 'string') throw new Error(`準備のトークン交換から ${type} を取得できませんでした。`);
  return value;
}

/** An OAuth endpoint form with optional credentials registered on the demo OP. */
function form(path: string, fields: Record<string, string>, client?: string, auth: 'basic' | 'post' | 'none' | 'wrong' = 'basic', headers: SandboxRequest['headers'] = []): SandboxRequest {
  const sent: SandboxRequest['headers'] = [['content-type', 'application/x-www-form-urlencoded'], ...headers];
  const params = new URLSearchParams(fields);
  if (client !== undefined) {
    const registration = PREMISES.clients.find((item) => item.clientId === client);
    if (registration === undefined) throw new Error(`クライアント ${client} が登録されていません。`);
    const secret = registration.clientSecret ?? '';
    if (auth === 'basic' || auth === 'wrong') {
      sent.push(['authorization', `Basic ${btoa(`${encodeURIComponent(client)}:${encodeURIComponent(auth === 'wrong' ? 'wrong-secret' : secret)}`)}`]);
    } else {
      params.set('client_id', client);
      if (auth === 'post') params.set('client_secret', secret);
    }
  }
  return { method: 'POST', path, headers: sent, body: params.toString() };
}

/** Exchange the code issued during preparation. */
function codeRequest(context: ScenarioContext, auth?: 'basic' | 'post' | 'none', changes: Record<string, string> = {}): SandboxRequest {
  const grant = grantOf(context);
  return form('/token', {
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
    code_verifier: grant.codeVerifier,
    ...changes,
  }, grant.clientId, auth);
}

/** Refresh an authorization grant, with optional narrower scope. */
function refreshRequest(context: ScenarioContext, scope?: string): SandboxRequest {
  return form('/token', {
    grant_type: 'refresh_token',
    refresh_token: tokenOf(context, 'refresh_token'),
    ...(scope === undefined ? {} : { scope }),
  }, CODE_CLIENT);
}

/** Ask for a bearer token as the demo service. */
function serviceRequest(fields: Record<string, string> = {}, client = SERVICE_CLIENT, auth?: 'basic' | 'wrong'): SandboxRequest {
  return form('/token', { grant_type: 'client_credentials', scope: 'reports.read', ...fields }, client, auth);
}

/** Configure a demo service that authenticates using its registered public key. */
async function privateKeyPlan(now: number) {
  const { publicJwk: { kty, n, e }, keyId } = await rs256Key(ASSERTION_KEY_ID);
  if (kty !== 'RSA' || n === undefined || e === undefined) throw new Error('The demo client requires an RSA public key.');
  return {
    ...PREMISES,
    now,
    clients: [{
      clientId: PRIVATE_KEY_CLIENT,
      authMethod: 'private_key_jwt' as const,
      grantTypes: ['client_credentials'],
      redirectUris: [],
      scope: ['reports.read'],
      clientAssertionKeys: [{ kty, n, e, kid: keyId, alg: 'RS256', use: 'sig' }],
    }],
    grants: [],
  };
}

/** Authenticate the service with a signed assertion instead of a shared secret. */
async function privateKeyRequest(context: ScenarioContext, expired = false): Promise<SandboxRequest> {
  const { privateKey, keyId } = await rs256Key(ASSERTION_KEY_ID);
  const issuedAt = context.now - (expired ? 600 : 0);
  const assertion = await signJwt({ alg: 'RS256', kid: keyId }, {
    iss: PRIVATE_KEY_CLIENT,
    sub: PRIVATE_KEY_CLIENT,
    aud: new URL('/token', context.issuer).href,
    iat: issuedAt,
    exp: issuedAt + 120,
    jti: crypto.randomUUID(),
  }, privateKey);
  return form('/token', { grant_type: 'client_credentials', scope: 'reports.read', client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion });
}

/** Ask to exchange an existing token, with optional custom subject type or target. */
function exchangeRequest(subjectToken: string, fields: Record<string, string> = {}, client = SERVICE_CLIENT): SandboxRequest {
  return form('/token', {
    grant_type: TOKEN_EXCHANGE,
    subject_token_type: ACCESS_TOKEN_TYPE,
    subject_token: subjectToken,
    ...fields,
  }, client);
}

/** Present an access token to the UserInfo endpoint. */
function userinfo(token?: string, method: 'GET' | 'POST' = 'GET'): SandboxRequest {
  return { method, path: '/userinfo', headers: token === undefined ? [] : [['authorization', `Bearer ${token}`]] };
}

/** Request introspection of an access or refresh token. */
function introspection(token: string, hint?: 'access_token' | 'refresh_token', signed = false): SandboxRequest {
  return form('/introspect', { token, ...(hint === undefined ? {} : { token_type_hint: hint }) }, CODE_CLIENT, 'basic',
    signed ? [['accept', 'application/token-introspection+jwt']] : []);
}

/** Request revocation of an access or refresh token. */
function revocation(token: string, hint: 'access_token' | 'refresh_token' = 'access_token', client = CODE_CLIENT, auth: 'basic' | 'post' | 'none' | 'wrong' = 'basic'): SandboxRequest {
  return form('/revoke', { token, token_type_hint: hint }, client, auth);
}

export const tokenRecipes: Record<string, ScenarioRecipe> = {
  'token-authorization-code': { plan: withGrant('unused'), request: (context) => codeRequest(context) },
  'token-authorization-code-post-secret': { plan: withGrant('unused', 'post'), request: (context) => codeRequest(context, 'post') },
  'token-authorization-code-public': { plan: withGrant('unused', 'public'), request: (context) => codeRequest(context, 'none') },
  'token-authorization-code-used': { plan: withGrant('exchanged'), request: (context) => codeRequest(context) },
  'token-authorization-code-pkce-mismatch': { plan: withGrant('unused'), request: (context) => codeRequest(context, 'basic', { code_verifier: PKCE_OTHER_VERIFIER }) },
  'token-authorization-code-redirect-mismatch': { plan: withGrant('unused'), request: (context) => codeRequest(context, 'basic', { redirect_uri: 'https://rp.example.com/other-callback' }) },
  'token-refresh': { plan: withGrant('exchanged'), request: (context) => refreshRequest(context) },
  'token-refresh-narrower-scope': { plan: withGrant('exchanged'), request: (context) => refreshRequest(context, 'openid') },
  'token-refresh-expanded-scope': { plan: withGrant('exchanged'), request: (context) => refreshRequest(context, 'openid email') },
  'token-refresh-reused': {
    plan: withGrant('exchanged'),
    async request(context) {
      const request = refreshRequest(context);
      const issued = await context.send(request);
      if (issued.status !== 200) throw new Error(`リフレッシュトークンの更新に失敗しました（HTTP ${issued.status}）。`);
      return request;
    },
  },
  'token-client-credentials': { request: () => serviceRequest() },
  'token-client-not-authorized': { request: () => serviceRequest({}, CODE_CLIENT) },
  'token-client-credentials-scope-not-allowed': { request: () => serviceRequest({ scope: 'reports.delete' }) },
  'token-client-credentials-target-not-allowed': { request: () => serviceRequest({ audience: 'https://api.example.com' }) },
  'token-invalid-client-secret': { request: () => serviceRequest({}, SERVICE_CLIENT, 'wrong') },
  'token-private-key-client': { plan: privateKeyPlan, request: (context) => privateKeyRequest(context) },
  'token-private-key-client-expired': { plan: privateKeyPlan, request: (context) => privateKeyRequest(context, true) },
  'token-exchange': { plan: withGrant('exchanged'), request: (context) => exchangeRequest(tokenOf(context, 'access_token'), { scope: 'openid' }) },
  'token-exchange-target-not-allowed': { plan: withGrant('exchanged'), request: (context) => exchangeRequest(tokenOf(context, 'access_token'), { audience: 'https://api.example.com' }) },
  'token-exchange-unknown-subject': { request: () => exchangeRequest(NO_TOKEN) },
  'token-id-jag-target-not-allowed': {
    plan: withGrant('exchanged', 'id-jag'),
    request: (context) => exchangeRequest(tokenOf(context, 'id_token'), {
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: ID_JAG_TYPE,
      audience: 'https://partner.example.com',
    }, CODE_CLIENT),
  },
  'token-id-jag-missing-assertion': {
    plan: (now) => ({
      ...PREMISES,
      now,
      clients: PREMISES.clients.map((client) => client.clientId === CODE_CLIENT ? { ...client, grantTypes: [...client.grantTypes, JWT_BEARER] } : client),
      grants: [],
    }),
    request: () => form('/token', { grant_type: JWT_BEARER }, CODE_CLIENT),
  },
  'token-unsupported-grant': { request: () => form('/token', { grant_type: 'unsupported_grant' }, CODE_CLIENT) },
  'token-missing-grant': { request: () => form('/token', {}, CODE_CLIENT) },

  'userinfo-bearer-get': { plan: withGrant('exchanged'), request: (context) => userinfo(tokenOf(context, 'access_token')) },
  'userinfo-bearer-post': { plan: withGrant('exchanged'), request: (context) => userinfo(tokenOf(context, 'access_token'), 'POST') },
  'userinfo-form-token': { plan: withGrant('exchanged'), request: (context) => form('/userinfo', { access_token: tokenOf(context, 'access_token') }) },
  'userinfo-signed-response': { plan: withGrant('exchanged', 'signed-userinfo'), request: (context) => userinfo(tokenOf(context, 'access_token')) },
  'userinfo-without-token': { request: () => userinfo() },
  'userinfo-unknown-token': { request: () => userinfo(NO_TOKEN) },
  'userinfo-id-token': { plan: withGrant('exchanged'), request: (context) => userinfo(tokenOf(context, 'id_token')) },
  'userinfo-insufficient-scope': {
    async request(context) {
      const response = await context.send(serviceRequest());
      if (response.status !== 200) throw new Error(`サービスのトークン発行に失敗しました（HTTP ${response.status}）。`);
      const payload = JSON.parse(response.body) as { access_token?: unknown };
      if (typeof payload.access_token !== 'string') throw new Error('サービスのアクセストークンを取得できませんでした。');
      return userinfo(payload.access_token);
    },
  },

  'introspection-active-access-token': { plan: withGrant('exchanged'), request: (context) => introspection(tokenOf(context, 'access_token'), 'access_token') },
  'introspection-active-refresh-token': { plan: withGrant('exchanged'), request: (context) => introspection(tokenOf(context, 'refresh_token'), 'refresh_token') },
  'introspection-signed-response': { plan: withGrant('exchanged'), request: (context) => introspection(tokenOf(context, 'access_token'), undefined, true) },
  'introspection-unknown-token': { request: () => introspection(NO_TOKEN) },
  'introspection-revoked-token': {
    plan: withGrant('exchanged'),
    async request(context) {
      const token = tokenOf(context, 'access_token');
      const response = await context.send(revocation(token));
      if (response.status !== 200) throw new Error(`トークンの取り消しに失敗しました（HTTP ${response.status}）。`);
      return introspection(token);
    },
  },
  'introspection-public-client': { plan: withGrant('exchanged', 'public'), request: (context) => form('/introspect', { token: tokenOf(context, 'access_token') }, CODE_CLIENT, 'none') },
  'introspection-missing-token': { request: () => form('/introspect', {}, CODE_CLIENT) },

  'revocation-access-token': { plan: withGrant('exchanged'), request: (context) => revocation(tokenOf(context, 'access_token')) },
  'revocation-refresh-token': { plan: withGrant('exchanged'), request: (context) => revocation(tokenOf(context, 'refresh_token'), 'refresh_token') },
  'revocation-public-client': { plan: withGrant('exchanged', 'public'), request: (context) => revocation(tokenOf(context, 'access_token'), 'access_token', CODE_CLIENT, 'none') },
  'revocation-unknown-token': { request: () => revocation(NO_TOKEN) },
  'revocation-other-client': { plan: withGrant('exchanged'), request: (context) => revocation(tokenOf(context, 'access_token'), 'access_token', POST_CLIENT, 'post') },
  'revocation-invalid-client-secret': { plan: withGrant('exchanged'), request: (context) => revocation(tokenOf(context, 'access_token'), 'access_token', CODE_CLIENT, 'wrong') },
};
