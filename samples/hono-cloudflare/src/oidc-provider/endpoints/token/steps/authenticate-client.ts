import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { verifyPresentedClientCredential } from '../../../client-auth.js';
import type { TokenRequestBody } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'token',
  kind: 'validate',
  label: 'クライアントを認証する',
  spec: 'OAuth 2.1 §2.3 / OIDC Core 1.0 §9',
  function: 'authenticateTokenClient',
  consumes: ['params', 'authorization'],
  produces: ['tokenClient', 'authenticatedClientId'],
  removable: false,
});

/**
 * クライアントを認証し、認証したクライアントを返す。
 *
 * 対応する認証方式は `client_secret_basic`、`client_secret_post`、`private_key_jwt` である。
 * `none` で登録したパブリッククライアントは、`client_id` だけで識別する。
 * `private_key_jwt` のクライアントアサーションは、`aud` にトークンエンドポイントの URL か issuer を求め、`jti` を消費して再利用を拒否する（`verifyPresentedClientCredential()`、client-auth.ts）。
 * 認証に失敗すると、中で呼ぶ core の関数が `TokenError`（`invalid_client` など）を投げる。
 *
 * 中の処理はそれぞれ core の独立した関数なので、認証情報の確認を独自の検証に差し替えても、ほかの処理は変えずに済む。
 *
 * @spec OAuth 2.1 §2.3
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7523 §3
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

  // `client_secret` を定数時間で比較するか、`private_key_jwt` のクライアントアサーションを検証する（OAuth 2.1 §7.4.1、OIDC Core 1.0 §9）。
  await verifyPresentedClientCredential(c, tokenClient, presentedCredentials, '/token');

  return { tokenClient, authenticatedClientId: presentedCredentials.clientId };
}
