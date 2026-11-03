import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'validate',
  label: 'クライアントを認証する',
  spec: 'RFC 7009 §2.1 / OAuth 2.1 §2.3',
  function: 'authenticateRevocationClient',
  consumes: ['params', 'authorization'],
  produces: ['authenticatedClientId'],
  removable: false,
});

/**
 * クライアントを認証し、その `client_id` を返す。
 *
 * 認証の手順はトークンエンドポイントと同じである（OAuth 2.1 §2.3、OIDC Core 1.0 §9）。
 * `token_endpoint_auth_method` を `none` で登録したパブリッククライアントは、`client_id` だけで通る（RFC 7009 §2.1）。
 * 認証に失敗すると、中で呼ぶ core の関数が `TokenError`（`invalid_client` など）を投げる。
 *
 * @spec RFC 7009 §2.1
 * @spec OAuth 2.1 §2.3
 * @spec OIDC Core 1.0 §9
 */
export async function authenticateRevocationClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<string> {
  const tokenClientResolver = c.get('tokenClientResolver');
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const revokingClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(revokingClient, presentedCredentials);
  await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
  return presentedCredentials.clientId;
}
