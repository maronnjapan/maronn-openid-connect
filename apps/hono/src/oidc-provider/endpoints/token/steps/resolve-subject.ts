import {
  type ValidatedTokenRequest,
  TokenError,
  TokenErrorCode,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-subject',
  endpoint: 'token',
  kind: 'resolve',
  label: 'サブジェクト、auth_time、nonce を取り出す',
  spec: 'OIDC Core 1.0 §12.2',
  function: 'resolveTokenSubject',
  consumes: ['validatedRequest'],
  produces: ['subject', 'authTime', 'nonce'],
  removable: false,
});

/**
 * サブジェクト、`auth_time`、`nonce` を返す。
 *
 * どれも、これから発行するトークンに入れる値である。
 * `authorization_code` グラントでは、ストアの認可コードのレコードからサブジェクトと `auth_time` を読み、`nonce` には検証済みのリクエストの値を使う。
 * レコードにサブジェクトか `auth_time` がなければ、`TokenError`（`invalid_grant`）を投げる。
 * `refresh_token` グラントでは、リフレッシュトークンに保存したサブジェクトと `auth_time` を返し、`nonce` は `undefined` にする。
 *
 * @spec OIDC Core 1.0 §12.2
 */
export async function resolveTokenSubject(
  c: any,
  validatedRequest: ValidatedTokenRequest,
): Promise<{ subject: string; authTime: number | undefined; nonce: string | undefined }> {
  if (validatedRequest.grantType === 'authorization_code') {
    const authCodeStore = c.get('authCodeStore');
    const authCode = await authCodeStore.get(validatedRequest.code);
    if (!authCode?.subject || !authCode.authTime) {
      throw new TokenError(
        TokenErrorCode.InvalidGrant,
        'Authorization code missing required subject context',
      );
    }
    return { subject: authCode.subject, authTime: authCode.authTime, nonce: validatedRequest.nonce };
  }
  // `refresh_token` グラントでは、リフレッシュトークンに保存したサブジェクトと `auth_time` を返し、`nonce` は入れない。
  // OIDC Core 1.0 §12.2 は、発行し直す ID トークンが保つクレームに `iss`、`sub`、`aud`、`exp`、`iat`、`auth_time`、`azp`、`acr`、`amr` を挙げ、`nonce` を挙げていない。
  // `nonce` は認証リクエストとその ID トークンを結び付ける値で（OIDC Core 1.0 §2）、リフレッシュにはその認証リクエストがないので、古い `nonce` を入れてもリプレイを防ぐことにはならない。
  // 主な OP（Google、Auth0）もリフレッシュでは `nonce` を省いており、この OP も省く。
  // `auth_time` は §12.1 に従って引き継ぐ。
  return { subject: validatedRequest.subject, authTime: validatedRequest.authTime, nonce: undefined };
}
