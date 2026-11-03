import {
  type TokenRequestParams,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  type ValidatedAuthorizationCodeRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-authorization-code-grant',
  endpoint: 'token',
  kind: 'validate',
  label: 'authorization_code グラントを検証する',
  spec: 'OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2',
  function: 'validateAuthorizationCodeGrant',
  consumes: ['params', 'authenticatedClientId', 'grantType', 'refreshTokenRequest'],
  optional: ['refreshTokenRequest'],
  produces: ['validatedRequest'],
  removable: false,
});

/**
 * 認可コードを検証し、検証済みリクエストを返す。
 *
 * 検証に通った認可コードは、ストアで使用済みにする。
 * `code` がない、認可コードが見つからない、使用済み、ほかのクライアントに発行された、期限切れ、`redirect_uri` が認可リクエストと合わない、PKCE の `code_verifier` が合わないときは、中で呼ぶ core の関数が `TokenError`（`invalid_grant` など）を投げる。
 * 使用済みの認可コードが再び提示されたときは、そのグラントから発行したトークンを失効させてから拒否する。
 *
 * 安全のための規則はそれぞれ core の別々の関数なので、一つずつ取り除いたり、差し替えたり、実験用の処理を前後に挟んだりできる。
 *
 * @spec OAuth 2.1 §4.1.2
 * @spec RFC 7636
 * @spec OIDC Core 1.0 §3.1.3.2
 */
export async function validateAuthorizationCodeGrant(
  c: any,
  params: TokenRequestParams,
  authenticatedClientId: string,
): Promise<ValidatedAuthorizationCodeRequest> {
  const authorizationCodeResolver = c.get('authCodeResolver');

  // `code` パラメータがあることを確かめ、提示された認可コードのレコードをストアから取得する。
  const { code, authorizationCode } = await resolveAuthorizationCode(
    params,
    authorizationCodeResolver,
  );

  // 使用済みの認可コードなら、そのグラントから発行したトークンを失効させてから拒否する（OAuth 2.1 §4.1.2）。
  await validateAuthorizationCodeUnused(
    authorizationCode,
    authorizationCodeResolver,
  );

  // 認可コードが認証したクライアントに発行されたものであることと、有効期限が切れていないことを確かめる。
  validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
  validateAuthorizationCodeExpiration(authorizationCode);

  // トークンリクエストの `redirect_uri` を、認可コードに保存した値と照らし合わせる（OIDC Core 1.0 §3.1.3.2）。
  validateAuthorizationCodeRedirectUri(
    authorizationCode,
    params.redirect_uri,
  );

  // 認可コードに PKCE の値が保存されていれば、`code_verifier` を S256 で検証する（RFC 7636）。
  const codeVerified = await verifyAuthorizationCodePkce(
    authorizationCode,
    params.code_verifier,
  );

  // 認可コードを削除せずに使用済みにし、後で再び提示されたときに再利用として検出できるようにする。
  await consumeAuthorizationCode(code, authorizationCodeResolver);

  return buildValidatedAuthorizationCodeRequest(
    code,
    authorizationCode,
    authenticatedClientId,
    codeVerified,
  );
}
