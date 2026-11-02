import { selectSigningKeyByAlg, type SigningKey } from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import { TokenEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'select-signing-keys',
  endpoint: 'token',
  kind: 'resolve',
  label: 'Select the signing keys',
  spec: 'OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)',
  function: 'selectTokenSigningKeys',
  consumes: ['authenticatedClientId'],
  produces: ['signingKey', 'idTokenSigningKey'],
  removable: false,
});

/**
 * アクセストークンと ID トークンの署名鍵を選んで返す。
 *
 * アクセストークンには、登録された鍵のうち最初の鍵を使う（`SigningKeyProvider` では、新しいトークンには最初の鍵で署名すると決めている）。
 * ID トークンには、クライアントが `id_token_signed_response_alg` に登録した `alg` の鍵を使い、登録がなければ RS256 の鍵を使う（OpenID Connect Dynamic Client Registration 1.0 §2）。
 * その `alg` の鍵がなければ、サーバーの設定の誤りとして `TokenEndpointError`（500、`server_error`）を投げる。
 *
 * @spec OpenID Connect Dynamic Client Registration 1.0 §2
 */
export async function selectTokenSigningKeys(
  c: any,
  authenticatedClientId: string,
): Promise<{ signingKey: SigningKey; idTokenSigningKey: SigningKey }> {
  const tokenClientResolver = c.get('tokenClientResolver');
  // 新しいトークンには、登録された鍵のうち最初の鍵で署名する（`SigningKeyProvider` の決まり）。
  const signingKey: SigningKey = c.get('signingKeys')[0];

  // ID トークンの署名鍵として、`alg` がクライアントの `id_token_signed_response_alg` と一致する鍵を選ぶ（OpenID Connect Dynamic Client Registration 1.0 §2）。
  // - `id_token_signed_response_alg` を登録していないクライアントには、仕様の既定の RS256 を使う。
  // - その `alg` の鍵が登録されていなければ、サーバーの設定の誤り（`server_error`）にする。
  const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const registeredClient = (await tokenClientResolver.findClient(authenticatedClientId)) as
    | RegisteredClient
    | null;
  const requestedIdTokenAlg = registeredClient?.idTokenSignedResponseAlg;
  let idTokenSigningKey: SigningKey;
  try {
    idTokenSigningKey = selectSigningKeyByAlg(idTokenSigningKeys, requestedIdTokenAlg);
  } catch {
    throw new TokenEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: `No ID Token signing key registered for alg "${requestedIdTokenAlg ?? 'RS256'}"`,
      },
    });
  }
  return { signingKey, idTokenSigningKey };
}
