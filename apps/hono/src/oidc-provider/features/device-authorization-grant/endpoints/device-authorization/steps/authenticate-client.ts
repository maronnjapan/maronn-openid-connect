import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'device-authorization',
  feature: 'device-authorization-grant',
  kind: 'validate',
  label: 'Authenticate the client',
  spec: 'RFC 8628 §3.1 / RFC 6749 §3.2.1',
  function: 'authenticateDeviceClient',
  consumes: ['params', 'authorization'],
  produces: ['client'],
  removable: false,
});

/**
 * クライアントを認証し、認証したクライアントを返す。
 *
 * このエンドポイントにも、RFC 6749 §3.2.1 のクライアント認証の要件が当てはまる（RFC 8628 §3.1）。
 * そのため、トークンエンドポイントと同じ core の関数を同じ順に呼び、提示された認証情報を読み取り、登録済みのクライアントを取得し、認証方式を確かめ、`client_secret` を比較する。
 * 認証に失敗すると、中で呼ぶ core の関数が `TokenError`（`invalid_client` など）を投げる。
 * パブリッククライアントは `client_id` だけを提示する。
 *
 * @spec RFC 8628 §3.1
 * @spec RFC 6749 §3.2.1
 */
export async function authenticateDeviceClient(
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
  await verifyClientSecret(client, presentedCredentials.clientSecret);
  return client;
}
