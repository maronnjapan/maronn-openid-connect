/**
 * What the OP of the map is given before any request a reader runs, as
 * plain data: its issuer and its clock, the clients and the users it is
 * configured with, and the grants it gives by requests (prepare.ts makes
 * them: the codes and tokens it holds are those its own requests issued,
 * each with the request that stored it). Every request a reader runs starts
 * anew from what they leave: the code one request exchanges is there again
 * for the next.
 *
 * The clients, the users and the clock are those of the tests of the token
 * endpoint (apps/hono/src/test-support/token.ts, the development users), so
 * a request one of those tests sends with them takes the same way here.
 * This module imports nothing: the page reads it without the OP
 * (`@maronn-openid-connect/map-sandbox/premises`).
 */

/** A client registered with the OP. */
export interface PremiseClient {
  clientId: string;
  /** Its secret, for the methods that send one. */
  clientSecret?: string;
  /** How it authenticates at the token endpoint (RFC 7591 §2 `token_endpoint_auth_method`). */
  authMethod: 'client_secret_basic' | 'client_secret_post' | 'none';
  grantTypes: string[];
  redirectUris: string[];
  /** The scopes it may request; absent for any the OP supports. */
  scope?: string[];
  /** Public ES256 keys registered for verifying a signed Request Object. */
  requestObjectKeys?: Array<{ kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string; alg: 'ES256'; use: 'sig' }>;
}

/** A user who can sign in at the login page: one of the development users the OP registers (seed.ts), with the password the login form is sent with. */
export interface PremiseUser {
  username: string;
  password: string;
}

/**
 * An authorization the OP of the map gives before any request a reader
 * runs, by the requests that give it (prepare.ts): the authorization request
 * a client sends, then what a browser does on the OP's pages after it (the
 * login form submitted as the user, the consent approved), up to the
 * redirect back to the client with a code; with `exchange`, the code is then
 * exchanged at the token endpoint, so the OP holds the code used and the
 * tokens it issued.
 */
export interface PremiseGrant {
  /** What the map calls it. */
  id: string;
  /** The query of the authorization request the client sends (OAuth 2.0 §4.1.1, OIDC Core 1.0 §3.1.2.1, RFC 7636 §4.3). */
  authorize: Record<string, string>;
  /** The PKCE verifier of its code_challenge (RFC 7636 §4.1), sent with the code to the token endpoint. */
  codeVerifier: string;
  /** The user who signs in at the login page and approves at the consent page (a username of the users). */
  username: string;
  /** Exchange the code at the token endpoint with the client's credentials. */
  exchange: boolean;
}

/** What the OP of the map holds (see the module comment). */
export interface Premises {
  issuer: string;
  /** The clock while a request runs, in Unix seconds: it stands still there. */
  now: number;
  clients: PremiseClient[];
  users: PremiseUser[];
  /** The authorizations the OP gives by requests before a request of the reader, in order. */
  grants: PremiseGrant[];
}

const REDIRECT_URI = 'https://rp.example.com/callback';
/** RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge. */
const PKCE = { verifier: 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz', challenge: 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU' };

/** The authorization request of client-1 for testuser with PKCE (S256), asking for the scopes given; with offline_access, prompt=consent too, without which the OP drops offline_access (OIDC Core 1.0 §11). */
function authorizationOf(scope: string, state: string, nonce: string): Record<string, string> {
  return {
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    nonce,
    ...(scope.split(' ').includes('offline_access') ? { prompt: 'consent' } : {}),
    code_challenge: PKCE.challenge,
    code_challenge_method: 'S256',
  };
}

/** What the OP of the map holds (see the module comment). */
export const PREMISES: Premises = {
  issuer: 'https://op.example.com',
  // 2026-01-01T00:00:00Z, the clock of the tests that fake Date.
  now: 1767225600,
  clients: [
    { clientId: 'client-1', clientSecret: 'client-1-secret-value', authMethod: 'client_secret_basic', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: [REDIRECT_URI] },
    // Another client of the code flow, which sends its secret in the body: the codes and tokens of client-1 are not its own.
    { clientId: 'client-2', clientSecret: 'client-2-secret-value', authMethod: 'client_secret_post', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: [REDIRECT_URI] },
    // The client of the client_credentials and token exchange tests (features/client-credentials, features/token-exchange), with the scopes of its resource server.
    { clientId: 'service-1', clientSecret: 'service-1-secret-value', authMethod: 'client_secret_basic', grantTypes: ['client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange'], redirectUris: [], scope: ['reports.read', 'reports.write'] },
  ],
  // The development users of apps/hono (oidc-provider/development.ts).
  users: [
    { username: 'testuser', password: 'password' },
    { username: 'otheruser', password: 'password' },
  ],
  grants: [
    // A code no request has exchanged yet; asked with offline_access, its exchange issues a refresh token too.
    { id: 'unused', authorize: authorizationOf('openid offline_access', 'state-1', 'nonce-1'), codeVerifier: PKCE.verifier, username: 'testuser', exchange: false },
    // A code exchanged already, and the access token and the refresh token its exchange issued.
    { id: 'exchanged', authorize: authorizationOf('openid profile offline_access', 'state-2', 'nonce-2'), codeVerifier: PKCE.verifier, username: 'testuser', exchange: true },
  ],
};
