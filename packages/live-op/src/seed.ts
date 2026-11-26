/**
 * What the live OP is deployed with: the environment of apps/hono's server
 * app (settings.ts reads it, as it reads the environment of a process),
 * with the clients the map's cases send requests as, and the development
 * users (oidc-provider/development.ts), which the app registers itself.
 *
 * The clients are registered as an operator configures apps/hono, through
 * OIDC_CLIENTS_JSON, each for one kind of request a case sends (`note`).
 * Each redirects to the example client of the tests
 * (`https://rp.example.com/callback`), which a case reads the code from
 * the redirect to, and to the callback page of the live OP
 * (`<issuer>/__live/callback`), which shows a browser that signed in what
 * the OP sent back.
 */
import type { ClientRegistration } from '../../../apps/hono/src/oidc-provider/config.js';
import type { LiveClient, LiveUser } from './api.js';
import { ASSERTION_KEY, REQUEST_OBJECT_KEY } from './demo-keys.js';

/** The redirect URI of the example client the cases read codes from. */
export const RP_CALLBACK = 'https://rp.example.com/callback';

/** The post-logout redirect URI registered for client-1 (RP-Initiated Logout 1.0 §3). */
export const RP_LOGOUT = 'https://rp.example.com/bye';

/** The path of the callback page of the live OP. */
export const LIVE_CALLBACK_PATH = '/__live/callback';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
const CIBA = 'urn:openid:params:grant-type:ciba';

/** A client of the live OP: its registration (secret in the clear, as OIDC_CLIENTS_JSON takes it) and what the map uses it for. */
interface SeedClient {
  registration: ClientRegistration;
  note: string;
}

/** The public half of a private JWK. */
function publicHalf(privateJwk: Readonly<Record<string, string>>, kid: string, alg: string): Record<string, string> {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...rest } = privateJwk as Record<string, string>;
  return { ...rest, kid, alg, use: 'sig' };
}

/** The clients of the live OP (see the module comment). */
function seedClients(issuer: string): SeedClient[] {
  const redirectUris = [RP_CALLBACK, `${issuer}${LIVE_CALLBACK_PATH}`];
  const code = { grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], redirectUris };
  return [
    {
      note: '認可コードフローの機密クライアント（Basic 認証）',
      registration: { clientId: 'client-1', clientSecret: 'client-1-secret-value', clientType: 'confidential', tokenEndpointAuthMethods: ['client_secret_basic'], clientName: 'Live OP Client 1', ...code },
    },
    {
      note: '認可コードフローの機密クライアント（ボディで secret を送る）',
      registration: { clientId: 'client-2', clientSecret: 'client-2-secret-value', clientType: 'confidential', tokenEndpointAuthMethods: ['client_secret_post'], clientName: 'Live OP Client 2', ...code },
    },
    {
      note: '認可コードフローの公開クライアント（PKCE のみ）',
      registration: { clientId: 'public-client', clientType: 'public', tokenEndpointAuthMethods: ['none'], clientName: 'Live OP Public Client', ...code },
    },
    {
      note: '署名付き UserInfo を受け取るクライアント',
      registration: { clientId: 'signed-userinfo-client', clientSecret: 'signed-userinfo-client-secret-value', clientType: 'confidential', tokenEndpointAuthMethods: ['client_secret_basic'], userinfoSignedResponseAlg: 'RS256', ...code },
    },
    {
      note: 'Implicit / Hybrid フローのクライアント',
      registration: {
        clientId: 'implicit-client',
        clientSecret: 'implicit-client-secret-value',
        clientType: 'confidential',
        tokenEndpointAuthMethods: ['client_secret_basic'],
        grantTypes: ['authorization_code', 'implicit', 'refresh_token'],
        responseTypes: ['code', 'id_token', 'id_token token', 'code id_token', 'code token', 'code id_token token'],
        redirectUris,
      },
    },
    {
      note: '署名付き Request Object を送るクライアント（ES256）',
      registration: {
        clientId: 'request-object-client',
        clientType: 'public',
        tokenEndpointAuthMethods: ['none'],
        requestObjectSigningAlg: 'ES256',
        keys: { request_object: { keys: [publicHalf(REQUEST_OBJECT_KEY.privateJwk, REQUEST_OBJECT_KEY.kid, 'ES256') as never] } },
        ...code,
      },
    },
    {
      note: 'client_credentials とトークン交換のサービス',
      registration: {
        clientId: 'service-1',
        clientSecret: 'service-1-secret-value',
        clientType: 'confidential',
        tokenEndpointAuthMethods: ['client_secret_basic'],
        grantTypes: ['client_credentials', TOKEN_EXCHANGE],
        responseTypes: [],
        redirectUris: [],
        scope: ['reports.read', 'reports.write'],
      },
    },
    {
      note: 'private_key_jwt で認証するサービス',
      registration: {
        clientId: 'signed-assertion-client',
        clientType: 'confidential',
        tokenEndpointAuthMethods: ['private_key_jwt'],
        tokenEndpointAuthSigningAlg: 'RS256',
        grantTypes: ['client_credentials'],
        responseTypes: [],
        redirectUris: [],
        scope: ['reports.read'],
        keys: { private_key_jwt: { keys: [publicHalf(ASSERTION_KEY.privateJwk, ASSERTION_KEY.kid, 'RS256') as never] } },
      },
    },
    {
      note: 'ID-JAG（トークン交換と JWT bearer）を使うクライアント',
      registration: {
        clientId: 'xaa-client',
        clientSecret: 'xaa-client-secret-value',
        clientType: 'confidential',
        tokenEndpointAuthMethods: ['client_secret_basic'],
        grantTypes: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE, JWT_BEARER],
        responseTypes: ['code'],
        redirectUris,
      },
    },
    {
      note: 'デバイス認可グラントの公開クライアント（テレビ）',
      registration: { clientId: 'device-tv', clientType: 'public', tokenEndpointAuthMethods: ['none'], grantTypes: [DEVICE_CODE], responseTypes: [], redirectUris: [], scope: ['openid', 'profile'] },
    },
    {
      note: 'デバイス認可グラントの機密クライアント',
      registration: { clientId: 'device-tv-confidential', clientSecret: 'device-tv-confidential-secret-value', clientType: 'confidential', tokenEndpointAuthMethods: ['client_secret_post'], grantTypes: [DEVICE_CODE], responseTypes: [], redirectUris: [], scope: ['openid', 'profile'] },
    },
    {
      note: 'CIBA のクライアント（コールセンター）',
      registration: { clientId: 'call-center', clientSecret: 'call-center-secret-value', clientType: 'confidential', tokenEndpointAuthMethods: ['client_secret_basic'], grantTypes: [CIBA], responseTypes: [], redirectUris: [], scope: ['openid', 'profile'] },
    },
  ];
}

/** The development users of apps/hono (oidc-provider/development.ts), with the password the login form takes. */
export const LIVE_USERS: readonly LiveUser[] = [
  { username: 'testuser', password: 'password' },
  { username: 'otheruser', password: 'password' },
];

/** A seeded client as the pages show it. */
function shownClient({ registration, note }: SeedClient): LiveClient {
  return {
    clientId: registration.clientId,
    ...(registration.clientSecret === undefined ? {} : { clientSecret: registration.clientSecret }),
    authMethod: registration.tokenEndpointAuthMethods?.[0] ?? 'client_secret_basic',
    grantTypes: registration.grantTypes ?? [],
    ...(registration.responseTypes === undefined ? {} : { responseTypes: registration.responseTypes }),
    redirectUris: registration.redirectUris ?? [],
    ...(registration.scope === undefined ? {} : { scope: registration.scope }),
    note,
  };
}

/** The clients of the live OP of an issuer, as the pages show them. */
export function liveClients(issuer: string): LiveClient[] {
  return seedClients(issuer).map(shownClient);
}

/** A client of the live OP by its id (as the pages show it); undefined for none. */
export function liveClient(issuer: string, clientId: string): LiveClient | undefined {
  return liveClients(issuer).find((client) => client.clientId === clientId);
}

/**
 * The environment of apps/hono's server app for the live OP of an issuer,
 * signing with a key of the workspace (a private RS256 JWK, kept by the
 * workspace so the tokens it signed still verify after its host restarts).
 */
export function liveEnvironment(issuer: string, signingKeyJwk: JsonWebKey & { kid?: string }): Record<string, string> {
  return {
    ISSUER: issuer,
    OIDC_CLIENTS_JSON: JSON.stringify(seedClients(issuer).map(({ registration }) => registration)),
    OIDC_POST_LOGOUT_REDIRECT_URIS_JSON: JSON.stringify({ 'client-1': [RP_LOGOUT, `${issuer}${LIVE_CALLBACK_PATH}`] }),
    OIDC_SIGNING_KEY_JWK: JSON.stringify(signingKeyJwk),
    // Every reader registers clients in one workspace; reset the workspace to start over.
    OIDC_DCR_MAX_CLIENTS: '1000',
  };
}
