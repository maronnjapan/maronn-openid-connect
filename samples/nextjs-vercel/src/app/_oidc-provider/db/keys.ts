/**
 * The keys of the key-value store (--db kv) and the JSON record each of them
 * holds: the layout that schema.sql is for --db sql.
 *
 * A record is a JSON document under a key named after the entity of the ER
 * model it stores, with the attribute names of the model. What belongs to one
 * entity goes into its record: a client holds its authentication method,
 * secret, redirect URIs, grant types and scopes, and a transaction holds its
 * authentication request, so each of them is written in one set. Keys that
 * are not in the ER model hold what the OP needs on top of it: how a
 * transaction ended, the single-use markers of codes and refresh tokens, and
 * the grants (the codes and tokens issued for one authorization).
 *
 * Every key starts with KEY_PREFIX, so the OP can share a store with other
 * data. A value that comes from a request (an id, a subject) is URI-encoded in
 * the key, so a colon in it cannot reach into another key.
 *
 * A record that expires has a TTL and carries its expiry too (expired_at,
 * exp), which the stores check on every read: a store that removes expired
 * keys late (DynamoDB) still never returns an expired record. Clients, users,
 * browser sessions and consent do not expire; remove them yourself once they
 * are no longer needed.
 */
export const KEY_PREFIX = 'oidc:';

function key(...parts: string[]): string {
  return KEY_PREFIX + parts.map((part) => encodeURIComponent(part)).join(':');
}

export const keys = {
  /** Client, with its Client_auth, Client_secret, Redirect_Uri, Grant and Scope (ClientRecord). */
  client: (clientId: string) => key('client', clientId),
  /** Client_jwk: the public keys of a client for one purpose (ClientJwksRecord). */
  clientJwks: (clientId: string, purpose: string) => key('client_jwks', clientId, purpose),
  /** User (UserRecord). */
  user: (userId: string) => key('user', userId),
  /** Federated_identity, found by the account at the provider (FederatedIdentityRecord). */
  federatedIdentity: (provider: string, providerSub: string) =>
    key('federated_identity', provider, providerSub),
  /** Transaction, with its Authentication_request (TransactionRecord). */
  transaction: (transactionId: string) => key('transaction', transactionId),
  /**
   * Not in the ER model: how a transaction ended (TransactionResultRecord).
   * The transaction record never changes it, so an ended transaction cannot
   * start again.
   */
  transactionResult: (transactionId: string) => key('transaction_result', transactionId),
  /** Auth_user: the sign-in of a transaction (AuthUserRecord). */
  authUser: (transactionId: string) => key('auth_user', transactionId),
  /** Upstream_auth_request of a transaction (UpstreamAuthRequestRecord). */
  upstreamAuthRequest: (transactionId: string) => key('upstream_auth_request', transactionId),
  /** Not in the ER model: the transaction a nonce of an upstream request belongs to (UpstreamNonceRecord). */
  upstreamNonce: (nonce: string) => key('upstream_nonce', nonce),
  /** Code, under the SHA-256 hash of the code (CodeRecord). */
  code: (codeHash: string) => key('code', codeHash),
  /** Not in the ER model: written with setIfAbsent when the code is used. */
  codeUsed: (codeHash: string) => key('code_used', codeHash),
  /** Access_token, under the SHA-256 hash of the token (AccessTokenRecord). */
  accessToken: (tokenHash: string) => key('access_token', tokenHash),
  /** Refresh_token, under the SHA-256 hash of the token (RefreshTokenRecord). */
  refreshToken: (tokenHash: string) => key('refresh_token', tokenHash),
  /** Not in the ER model: written with setIfAbsent when the refresh token is used. */
  refreshTokenUsed: (tokenHash: string) => key('refresh_token_used', tokenHash),
  /** Not in the ER model: a grant, the codes and tokens of one authorization (GrantRecord). */
  grant: (grantId: string) => key('grant', grantId),
  /** Not in the ER model: written when the access tokens of a grant are revoked. */
  grantAccessTokensRevoked: (grantId: string) => key('grant_access_tokens_revoked', grantId),
  /** Not in the ER model: written when the refresh tokens of a grant are revoked. */
  grantRefreshTokensRevoked: (grantId: string) => key('grant_refresh_tokens_revoked', grantId),
  /** Not in the ER model: a browser session for SSO, prompt=none and max_age (BrowserSessionRecord). */
  browserSession: (sessionId: string) => key('browser_session', sessionId),
  /** Not in the ER model: what a user consented to for a client (ConsentRecord). */
  consent: (subject: string, clientId: string) => key('consent', subject, clientId),
};

/** Client: id is the client_id, in the key. The OP does not know a deleted client (is_deleted). */
export interface ClientRecord {
  name: string | null;
  client_type: 'public' | 'confidential';
  is_deleted: boolean;
  /**
   * Client_auth (with its Client_secret): the methods the client may
   * authenticate with at the token endpoint. A public client has none. A
   * confidential client has one entry per method it may use:
   * client_secret_basic, client_secret_post or both. Every entry carries the
   * same secret, the hash from hashClientSecret() of the client's one
   * client_secret (RFC 7591 §2).
   */
  client_auths: ClientAuthRecord[];
  /** Redirect_Uri: the redirect URIs of the client. */
  redirect_uris: string[];
  /** Grant: the grant types the client may use. Empty: authorization_code only. */
  grant_types: string[];
  /**
   * Scope: the scopes the client may request. A request for any other scope is
   * rejected with invalid_scope. Empty: every scope the OP accepts.
   */
  scopes: string[];
}

/** One Client_auth of ClientRecord.client_auths, with its Client_secret. */
export interface ClientAuthRecord {
  client_auth_type: 'client_secret_basic' | 'client_secret_post';
  secret: string;
}

/**
 * Client_jwk: the public keys of a client for one purpose, as a JWK Set
 * (RFC 7517 §5). The purpose is part of the key and names the process that
 * uses the keys: request_object for the signed Request Objects the OP verifies
 * (OIDC Core 1.0 §6.3.2), or another one such as private_key_jwt (OIDC Core
 * 1.0 §9) or dpop (RFC 9449) for a process a project adds. The OP reads the
 * record of a purpose each time a process needs its keys, so a key added to it
 * or removed from it takes effect at once. Never store a private key.
 */
export interface ClientJwksRecord {
  keys: Array<Record<string, unknown>>;
}

/**
 * User: id is the sub, in the key. email and is_verified are the email and
 * email_verified claims. password_hash is the hash from hashPassword()
 * (users.ts), and null for a user who has no password and signs in another
 * way (such as Sign in with Google).
 */
export interface UserRecord {
  email: string | null;
  is_verified: boolean;
  password_hash: string | null;
  created_at: number;
  updated_at: number;
  /** Not in the ER model: the claims other than email and email_verified (name and so on). */
  claims: Record<string, unknown>;
  /** The Federated_identity records of the user, each found through keys.federatedIdentity(). */
  federated_identities?: Array<{ provider: string; provider_sub: string }>;
}

/** Federated_identity (google-login): the account of a user at an external IdP. */
export interface FederatedIdentityRecord {
  user_id: string;
  created_at: number;
  updated_at: number;
}

/**
 * Transaction: one authorization request on its way through the OP.
 * expired_at is when it expires, in epoch seconds like every time here.
 */
export interface TransactionRecord {
  /** The status while the transaction is in progress; how it ended is in keys.transactionResult(). */
  status: 'requested' | 'upstream_pending' | 'authenticated';
  created_at: number;
  expired_at: number;
  /** Authentication_request: what the authorization request asked for. */
  authentication_request: {
    client_id: string;
    redirect_uri: string;
    state: string | null;
    nonce: string | null;
    code_challenge: string | null;
    code_challenge_method: string | null;
    response_type: string;
    scope: string | null;
    /** Not in the ER model: the other parameters of the request (prompt, max_age, claims, ...). */
    payload: Record<string, unknown>;
  };
  /** Not in the ER model: the CSRF token, the failed sign-in attempts and the browser binding. */
  payload: Record<string, unknown>;
}

/**
 * Not in the ER model: failed when the transaction ended without a code,
 * code_issued once a code was issued from it, and token_issued once that code
 * was exchanged for tokens.
 */
export interface TransactionResultRecord {
  status: 'failed' | 'code_issued' | 'token_issued';
}

/** Auth_user: who signed in for a transaction, how and when. */
export interface AuthUserRecord {
  user_id: string;
  /** password, or the provider of the user's federated identity (such as google). */
  auth_type: string;
  auth_time: number;
  /** Not in the ER model: the browser session the sign-in created. */
  session_id: string | null;
}

/**
 * Upstream_auth_request (google-login): the request to the external IdP.
 * Sign in with Google (GIS redirect mode) sends no state and uses no PKCE, so
 * state and code_verifier are null. A transaction has one, so a newer login
 * page replaces the nonce of an older one.
 */
export interface UpstreamAuthRequestRecord {
  provider: string;
  state: string | null;
  nonce: string;
  code_verifier: string | null;
  expired_at: number;
}

/** Not in the ER model: the transaction of an upstream nonce. */
export interface UpstreamNonceRecord {
  transaction_id: string;
}

/** Code: an authorization code, under the hash of the code. */
export interface CodeRecord {
  /** The transaction the code was issued from. */
  transaction_id: string | null;
  expired_at: number;
  grant_id: string;
  /** Not in the ER model: what the token request checks (client, redirect URI, scope, PKCE, nonce, ...). */
  payload: Record<string, unknown>;
}

/** Access_token: an access token, under the hash of the token. */
export interface AccessTokenRecord {
  /** The jti, or the hash of a token issued without one. */
  id: string;
  sub: string;
  exp: number;
  iat: number | null;
  iss: string | null;
  client_id: string;
  /** Space-separated. */
  scope: string | null;
  /**
   * The acr claim of the token (RFC 9068, OpenID Connect Core 1.0): the
   * authentication context class it was issued for, the same as the acr of its
   * ID Token. null when the token has none, as when the authorization request
   * asked for no acr (acr_values).
   */
  acr: string | null;
  /** The transaction of the code the grant came from. null for the device flow and CIBA. */
  transaction_id: string | null;
  grant_id: string | null;
  /** Not in the ER model: the other values the OP needs (audience, auth_time, ...). */
  payload: Record<string, unknown>;
}

/** Refresh_token: a refresh token, under the hash of the token. */
export interface RefreshTokenRecord {
  /** The access token issued in the same token response. */
  access_token_id: string | null;
  exp: number;
  iat: number | null;
  grant_id: string;
  /** Not in the ER model: the other values the OP needs (client, scope, session, ...). */
  payload: Record<string, unknown>;
}

/**
 * Not in the ER model: a grant. Its code points to its transaction, and the
 * refresh token of a token response points to the access token issued just
 * before it. expired_at is when the grant's last code or token expires: the
 * record, and the revocation markers of the grant, live until then.
 */
export interface GrantRecord {
  transaction_id: string | null;
  latest_access_token: { id: string; iat: number | null } | null;
  expired_at: number;
}

/** Not in the ER model: a browser session (SSO, prompt=none, max_age). */
export interface BrowserSessionRecord {
  subject: string;
  auth_time: number;
}

/** Not in the ER model: the scopes a user consented to for a client, and the grants issued under them. */
export interface ConsentRecord {
  scopes: string[];
  grant_ids: string[];
}
