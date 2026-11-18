import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import { tokenTypeOf, type TokenBinding } from '../../../token-binding.js';
import type { TokenEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-token-response',
  endpoint: 'token',
  kind: 'transform',
  label: 'トークンレスポンスのボディを組み立てる',
  spec: 'OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1',
  function: 'buildTokenResponse',
  consumes: ['accessToken', 'idToken', 'refreshToken', 'validatedRequest', 'tokenBinding'],
  optional: ['refreshToken', 'tokenBinding'],
  produces: ['tokenResponse'],
  removable: false,
});

/**
 * トークンレスポンスのボディを組み立てて返す。
 *
 * ステータスは 200 で、ボディには `access_token`、`token_type`（`Bearer`。機能が鍵に束縛したトークンは束縛の `token_type`）、`expires_in`（設定の `accessTokenExpiresIn`）、`id_token`、`scope`（許可したスコープを空白で区切った文字列）、`refresh_token` を入れる。
 * ID トークンやリフレッシュトークンを発行しなかったときは、その値が `undefined` になり、JSON にするときにメンバーごと省かれる。
 *
 * @spec OIDC Core 1.0 §3.1.3.3
 * @spec RFC 6749 §5.1
 * @spec RFC 9449 §5
 */
export function buildTokenResponse(
  c: any,
  input: {
    accessToken: string;
    idToken: string | undefined;
    refreshToken?: string;
    validatedRequest: ValidatedTokenRequest;
    /** The key a feature (dpop) bound the access token to; undefined answers with a Bearer token. */
    binding?: TokenBinding;
  },
): TokenEndpointResponse {
  const { accessToken, idToken, refreshToken, validatedRequest, binding } = input;
  const config = c.get('config');
  return {
    status: 200,
    body: {
      access_token: accessToken,
      // 鍵に束縛したトークンは、束縛の `token_type`（DPoP なら `DPoP`）で返す（RFC 9449 §5）。
      token_type: tokenTypeOf(binding),
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: refreshToken,
    },
  };
}
