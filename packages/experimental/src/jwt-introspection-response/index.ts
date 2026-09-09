/**
 * JWT Response for OAuth Token Introspection — RFC 9701 (Proposed Standard,
 * 2025-01)
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で
 * `--enable jwt-introspection-response` を明示したときのみ生成コードから利用される。
 *
 * スコープは**署名付き応答（RS256 固定）のみ**に限定する。暗号化応答
 * （§6 の Nested JWT）・クライアント別 `introspection_signed_response_alg`
 * （§6）・アクセストークンによる RS 認証（§4）は非対応。Accept で JWT を
 * 要求しない従来の RFC 7662 JSON 応答は一切変えない。
 */
export {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
} from './accept.js';

export { restrictIntrospectionResponseToCaller } from './audience.js';

export {
  TOKEN_INTROSPECTION_JWT_TYP,
  createIntrospectionResponseJwt,
} from './response-jwt.js';
