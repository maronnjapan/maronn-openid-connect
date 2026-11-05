import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import type { TokenEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-token-response',
  endpoint: 'token',
  kind: 'transform',
  label: 'トークンレスポンスのボディを組み立てる',
  spec: 'OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1',
  function: 'buildTokenResponse',
  consumes: ['accessToken', 'idToken', 'refreshToken', 'validatedRequest'],
  optional: ['refreshToken'],
  produces: ['tokenResponse'],
  removable: false,
});

/**
 * トークンレスポンスのボディを組み立てて返す。
 *
 * ステータスは 200 で、ボディには `access_token`、`token_type`（`Bearer`）、`expires_in`（設定の `accessTokenExpiresIn`）、`id_token`、`scope`（許可したスコープを空白で区切った文字列）、`refresh_token` を入れる。
 * ID トークンやリフレッシュトークンを発行しなかったときは、その値が `undefined` になり、JSON にするときにメンバーごと省かれる。
 *
 * @spec OIDC Core 1.0 §3.1.3.3
 * @spec RFC 6749 §5.1
 */
export function buildTokenResponse(
  c: any,
  input: {
    accessToken: string;
    idToken: string | undefined;
    refreshToken?: string;
    validatedRequest: ValidatedTokenRequest;
  },
): TokenEndpointResponse {
  const { accessToken, idToken, refreshToken, validatedRequest } = input;
  const config = c.get('config');
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: refreshToken,
    },
  };
}
