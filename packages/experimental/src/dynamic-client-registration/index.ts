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
 * このモジュールは「登録リクエストの解析・software statement の検証と適用・
 * 登録メタデータの検証と既定値適用・登録レコードと 201 応答の組み立て・
 * initial access token の照合」だけを持つ純関数群で、HTTP にもストアにも
 * 触れない。`redirect_uris` の検査規則、response_type の正規化、JWS の検証、
 * 乱数生成は core 公開 API（validateRegisteredRedirectUris /
 * normalizeResponseType / parseRequestObject / generateRandomString）を使い、
 * クライアントの保存・総数上限・Content-Type 検査・登録できる値の一覧の決定は
 * 生成コード側の責務のまま変えない。
 *
 * スコープ外（非目標）: RFC 7592（登録後の参照・更新・削除、
 * registration_access_token / registration_client_uri はどちらも返さない）、
 * initial access token と software statement の発行、URL 参照系メタデータ
 * （jwks_uri / sector_identifier_uri など）の取得。
 */
export {
  ClientRegistrationError,
  isClientRegistrationError,
  type ClientRegistrationErrorCode,
} from './registration-error.js';

export {
  parseClientRegistrationBody,
  validateClientMetadata,
  validateClientRegistrationRequest,
  DEFAULT_TOKEN_ENDPOINT_AUTH_METHODS,
  DEFAULT_GRANT_TYPES,
  DEFAULT_RESPONSE_TYPES,
  STANDARD_CLIENT_METADATA_NAMES,
  type CustomClientMetadataValidator,
  type ParseClientRegistrationBodyOptions,
  type ParsedClientRegistration,
  type ValidateClientMetadataOptions,
  type ValidateClientRegistrationOptions,
  type ValidatedClientRegistration,
} from './registration-request.js';

export {
  applySoftwareStatement,
  verifySoftwareStatement,
  DEFAULT_SOFTWARE_STATEMENT_ALGORITHMS,
  type SoftwareStatementPublisher,
  type VerifiedSoftwareStatement,
  type VerifySoftwareStatementOptions,
} from './software-statement.js';

export {
  buildRegisteredClient,
  buildClientRegistrationResponse,
  CLIENT_SECRET_AUTH_METHODS,
  type BuildRegisteredClientOptions,
  type DynamicallyRegisteredClient,
} from './registered-client.js';

export { verifyInitialAccessToken } from './initial-access-token.js';
