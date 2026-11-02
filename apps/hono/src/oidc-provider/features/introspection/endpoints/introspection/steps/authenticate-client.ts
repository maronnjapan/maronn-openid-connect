import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireConfidentialIntrospectionCaller,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'validate',
  label: 'Authenticate the confidential client',
  spec: 'RFC 7662 §2.1 / OAuth 2.1 §2.3',
  function: 'authenticateIntrospectionClient',
  consumes: ['params', 'authorization'],
  produces: ['authenticatedClientId'],
  removable: false,
});

/**
 * クライアントを認証し、パブリッククライアントは拒む。
 *
 * 認証の手順はトークンエンドポイントと同じで、認証したクライアントの `client_id` を返す（OAuth 2.1 §2.3、OIDC Core 1.0 §9）。
 * 認証に失敗すると、中で呼ぶ core の関数が `TokenError`（`invalid_client` など）を投げる。
 * 呼び出し元がパブリッククライアントなら、`IntrospectionError`（`invalid_client`）を投げる。
 *
 * `token_endpoint_auth_method` を `none` で登録したクライアントは、公開されている `client_id` を示すだけで認証の手順を通るので、それを認証済みとして扱うと、誰でもトークンを探れてしまう。
 * 失効エンドポイントには、あえてこの確認を置いていない。
 * RFC 7009 §2.1 は、パブリッククライアントが自分のトークンを失効させることを認めているためである。
 *
 * @spec RFC 7662 §2.1
 * @spec RFC 9701 §5
 */
export async function authenticateIntrospectionClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<string> {
  const tokenClientResolver = c.get('tokenClientResolver');
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const introspectingClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(introspectingClient, presentedCredentials);
  await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
  requireConfidentialIntrospectionCaller(introspectingClient);
  return presentedCredentials.clientId;
}
