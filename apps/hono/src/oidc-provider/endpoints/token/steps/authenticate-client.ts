import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import type { TokenRequestBody } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'token',
  kind: 'validate',
  label: 'Authenticate the client',
  spec: 'OAuth 2.1 §2.3 / OIDC Core 1.0 §9',
  function: 'authenticateTokenClient',
  consumes: ['params', 'authorization'],
  produces: ['tokenClient', 'authenticatedClientId'],
  removable: false,
});

/**
 * クライアントを認証し、認証したクライアントを返す。
 *
 * 対応する認証方式は `client_secret_basic` と `client_secret_post` である。
 * `none` で登録したパブリッククライアントは、`client_id` だけで識別する。
 * 認証に失敗すると、中で呼ぶ core の関数が `TokenError`（`invalid_client` など）を投げる。
 *
 * 中の処理はそれぞれ core の独立した関数なので、`verifyClientSecret()` を独自の検証（`private_key_jwt` など）に差し替えても、ほかの処理は変えずに済む。
 *
 * @spec OAuth 2.1 §2.3
 * @spec OIDC Core 1.0 §9
 */
export async function authenticateTokenClient(
  c: any,
  params: TokenRequestBody,
  authorization: string,
): Promise<{ tokenClient: TokenClientInfo; authenticatedClientId: string }> {
  const tokenClientResolver = c.get('tokenClientResolver');

  // 提示された認証情報と、実際に使われた認証方式を読み取る。
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });

  // 提示された `client_id` の登録済みクライアントを取得する（RFC 6749 §5.2）。
  const tokenClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );

  // 使われた認証方式が、クライアントの登録した方式のどれかであることを確かめる（OIDC Core 1.0 §9）。
  // 認証方式のダウングレードや、パブリッククライアントとの取り違えを防ぐ。
  validateClientAuthMethod(tokenClient, presentedCredentials);

  // `client_secret` を定数時間で比較する（OAuth 2.1 §7.4.1）。
  await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

  return { tokenClient, authenticatedClientId: presentedCredentials.clientId };
}
