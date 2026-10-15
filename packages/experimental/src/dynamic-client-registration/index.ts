/**
 * OAuth 2.0 Dynamic Client Registration Protocol (RFC 7591) /
 * OpenID Connect Dynamic Client Registration 1.0 のサブセット
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で
 * `--enable dynamic-client-registration` を明示したときのみ生成コードから
 * 利用される。
 *
 * このモジュールは「登録メタデータの検証・既定値適用・登録レコードと 201
 * 応答の組み立て・initial access token の照合」だけを持つ純関数群で、HTTP
 * にもストアにも触れない。`redirect_uris` の検査規則と乱数生成は core 公開
 * API（validateRegisteredRedirectUris / generateRandomString）を使い、
 * クライアントの保存・総数上限・Content-Type 検査は生成コード側の責務の
 * まま変えない。
 *
 * スコープ外（非目標）: RFC 7592（登録後の参照・更新・削除、
 * registration_access_token / registration_client_uri はどちらも返さない）、
 * software_statement（未知フィールドとして無視）、initial access token の
 * 発行・管理、OIDC 固有メタデータ（jwks_uri など URL 参照系を含む）の解釈。
 */
export {
  ClientRegistrationError,
  validateClientRegistrationRequest,
  type ValidateClientRegistrationOptions,
  type ValidatedClientRegistration,
} from './registration-request.js';

export {
  buildRegisteredClient,
  buildClientRegistrationResponse,
  type BuildRegisteredClientOptions,
  type DynamicallyRegisteredClient,
} from './registered-client.js';

export { verifyInitialAccessToken } from './initial-access-token.js';
