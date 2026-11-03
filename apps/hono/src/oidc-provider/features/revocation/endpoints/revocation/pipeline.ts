import { Hono } from 'hono';
import { authenticateRevocationClient } from './steps/authenticate-client.js';
import { parseRevocationRequest } from './steps/parse-request.js';
import { resolveRevocationTokenTarget } from './steps/resolve-token.js';
import { respondRevocationError } from './steps/respond-error.js';
import { respondRevocation } from './steps/respond.js';
import { revokeToken } from './steps/revoke-token.js';

/**
 * Token Revocation endpoint (API layer).
 * RFC 7009 Section 2
 *
 * Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint revocation`): parse the
 * request, authenticate the client, resolve the token, revoke it with its
 * grant siblings, and answer. A step that throws ends in
 * respondRevocationError().
 *
 * Confidential clients authenticate with their registered secret method. Public
 * clients registered with token_endpoint_auth_method=none identify themselves
 * with client_id only (RFC 7009 §2.1).
 * Always returns 200 OK with no body for both "revoked" and "not found" cases
 * to prevent client side-channels (RFC 7009 Section 2.2).
 */
export const revocationApp = new Hono<{ Variables: Record<string, any> }>();

revocationApp.post('/', async (c) => {
  try {
    // [parse-request] 失効リクエストを解析する — RFC 7009 §2.1
    const { params, authorization } = await parseRevocationRequest(c);

    // [authenticate-client] クライアントを認証する — RFC 7009 §2.1 / OAuth 2.1 §2.3
    const authenticatedClientId = await authenticateRevocationClient(c, params, authorization);

    // [resolve-token] 提示されたトークンを取得する — RFC 7009 §2.1
    const { token, resolved } = await resolveRevocationTokenTarget(c, params, authenticatedClientId);

    // [revoke-token] トークンと同じグラントのトークンを失効させる — RFC 7009 §2.1
    await revokeToken(c, token, resolved, authenticatedClientId);

    // [respond] 空のボディの 200 で応答する — RFC 7009 §2.2
    return respondRevocation(c);
  } catch (error) {
    return respondRevocationError(c, error);
  }
});
