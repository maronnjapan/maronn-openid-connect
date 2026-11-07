import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { verifyPresentedClientCredential } from '../../../../../client-auth.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'validate',
  label: 'クライアントを認証する',
  spec: 'CIBA Core 1.0 §7.1',
  function: 'authenticateCibaClient',
  consumes: ['params', 'authorization'],
  produces: ['client'],
  removable: false,
});

/**
 * クライアントを認証し、認証したクライアントを返す。
 *
 * クライアントは、`client_id` に登録した認証方式で認証しなければならない（CIBA §7.1 の MUST）。
 * そのため、トークンエンドポイントと同じ core の関数を同じ順に呼び、提示された認証情報を読み取り、登録済みのクライアントを取得し、認証方式を確かめ、`client_secret` かクライアントアサーション（`private_key_jwt`。`aud` はこのエンドポイントの URL か issuer）を確かめる。
 * 認証に失敗すると、中で呼ぶ core の関数が `TokenError`（`invalid_client` など）を投げる。
 * 認証方式が `none` のパブリッククライアントはここを通るが、後の `create-request` のステップで `unauthorized_client` として拒否される。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export async function authenticateCibaClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<TokenClientInfo> {
  const tokenClientResolver = c.get('tokenClientResolver');
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const client = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(client, presentedCredentials);
  await verifyPresentedClientCredential(c, client, presentedCredentials, '/backchannel_authentication');
  return client;
}
