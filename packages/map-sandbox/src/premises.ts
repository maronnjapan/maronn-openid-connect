/**
 * What the OP of the map holds when a request starts: its issuer, its clock,
 * and the clients, codes and tokens issued before the request, as plain
 * data. The page shows them beside the request it edits, so the reader
 * writes a request that uses them, and the OP is seeded from them anew for
 * every request (seed.ts): the code one request exchanges is there again for
 * the next.
 *
 * The values are those of the tests of the token endpoint
 * (apps/hono/src/test-support/token.ts, and the code with PKCE of
 * endpoints/token/pipeline.test.ts), so a request one of those tests sends
 * takes the same way here. This module imports nothing: the page reads it
 * without the OP (`@maronn-openid-connect/map-sandbox/premises`).
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
}

/** An authorization code the OP issued that no request has exchanged yet. */
export interface PremiseCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  /** The user it was issued for. */
  subject: string;
  nonce?: string;
  /** PKCE (RFC 7636): the verifier a request sends, and the challenge kept with the code. */
  pkce?: { verifier: string; challenge: string; method: 'S256' };
  /** How many seconds after the clock it expires. */
  expiresIn: number;
  /** A request exchanged it already. */
  used?: boolean;
}

/** A refresh token the OP issued. */
export interface PremiseRefreshToken {
  token: string;
  clientId: string;
  /** The user it was issued for. */
  subject: string;
  scope: string[];
  /** How many seconds after the clock it expires. */
  expiresIn: number;
}

/** A user who can sign in at the login page. */
export interface PremiseUser {
  username: string;
  password: string;
}

/** What the OP of the map holds (see the module comment). */
export interface Premises {
  issuer: string;
  /** The clock while a request runs, in Unix seconds: it stands still there. */
  now: number;
  clients: PremiseClient[];
  codes: PremiseCode[];
  refreshTokens: PremiseRefreshToken[];
  users: PremiseUser[];
}

const REDIRECT_URI = 'https://rp.example.com/callback';

/** What the OP of the map holds (see the module comment). */
export const PREMISES: Premises = {
  issuer: 'https://op.example.com',
  // 2026-01-01T00:00:00Z, the clock of the tests that fake Date.
  now: 1767225600,
  clients: [
    { clientId: 'client-1', clientSecret: 'client-1-secret-value', authMethod: 'client_secret_basic', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: [REDIRECT_URI] },
    // Another client of the code flow, which sends its secret in the body: the codes and tokens of client-1 are not its own.
    { clientId: 'client-2', clientSecret: 'client-2-secret-value', authMethod: 'client_secret_post', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: [REDIRECT_URI] },
    // The client of the client_credentials tests (features/client-credentials), with the scopes of its resource server.
    { clientId: 'service-1', clientSecret: 'service-1-secret-value', authMethod: 'client_secret_basic', grantTypes: ['client_credentials'], redirectUris: [], scope: ['reports.read', 'reports.write'] },
  ],
  codes: [
    {
      code: 'code-1',
      clientId: 'client-1',
      redirectUri: REDIRECT_URI,
      scope: ['openid', 'offline_access'],
      subject: 'user-1',
      nonce: 'nonce-1',
      // RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
      pkce: { verifier: 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz', challenge: 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU', method: 'S256' },
      expiresIn: 300,
    },
    // A code issued without PKCE: the OP requires PKCE, so it cannot be exchanged.
    { code: 'code-2', clientId: 'client-1', redirectUri: REDIRECT_URI, scope: ['openid'], subject: 'user-1', nonce: 'nonce-1', expiresIn: 300 },
    // A code a request exchanged already.
    {
      code: 'code-used',
      clientId: 'client-1',
      redirectUri: REDIRECT_URI,
      scope: ['openid'],
      subject: 'user-1',
      pkce: { verifier: 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz', challenge: 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU', method: 'S256' },
      expiresIn: 300,
      used: true,
    },
  ],
  refreshTokens: [{ token: 'refresh-1', clientId: 'client-1', subject: 'user-1', scope: ['openid', 'profile', 'offline_access'], expiresIn: 86400 }],
  // The development users of apps/hono (oidc-provider/development.ts).
  users: [
    { username: 'testuser', password: 'password' },
    { username: 'otheruser', password: 'password' },
  ],
};
