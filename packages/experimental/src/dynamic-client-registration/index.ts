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
 * このモジュールは「登録リクエストの解析・software statement の適用・
 * 登録メタデータの検証と既定値適用・登録レコードと 201 応答の組み立て・
 * Authorization ヘッダの Bearer トークンの読み取り」だけを持つ純関数群で、
 * HTTP にもストアにも触れない。`redirect_uris` の検査規則、response_type の
 * 正規化、乱数生成は core 公開 API（validateRegisteredRedirectUris /
 * normalizeResponseType / generateRandomString）を使い、クライアントの保存・
 * 総数上限・Content-Type 検査・登録できる値の一覧の決定は生成コード側の
 * 責務のまま変えない。
 *
 * initial access token と software statement の検証は持たない。どちらも
 * RFC 7591 が検証の基準を定めないもので、OP の設定に渡した関数の責務である。
 * 生成コードは、関数が設定されているときだけ対応する値（Bearer トークン、
 * software_statement）の提示を要求し、無ければ要求しない。
 *
 * スコープ外（非目標）: RFC 7592（登録後の参照・更新・削除、
 * registration_access_token / registration_client_uri はどちらも返さない）、
 * initial access token と software statement の発行と検証、URL 参照系
 * メタデータ（jwks_uri / sector_identifier_uri など）の取得。
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

export { applySoftwareStatement, type VerifiedSoftwareStatement } from './software-statement.js';

export {
  buildRegisteredClient,
  buildClientRegistrationResponse,
  CLIENT_SECRET_AUTH_METHODS,
  type BuildRegisteredClientOptions,
  type DynamicallyRegisteredClient,
} from './registered-client.js';

export { readBearerToken } from './bearer-token.js';
