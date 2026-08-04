/**
 * OAuth 2.0 Token Exchange — RFC 8693
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で `--enable token-exchange` を
 * 明示したときのみ生成コードから利用される。
 *
 * 初期スコープは impersonation 型の交換（`actor_token` なし）に限定する。
 * `audience` / `resource` の複数指定には対応しない（生成 OP のトークン
 * エンドポイントが RFC 6749 §3.2 に基づき重複パラメータを拒否するため）。
 */
export {
  SUBJECT_TOKEN_INVALID_DESCRIPTION,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TokenExchangeError,
  authorizeTokenExchangeClient,
  buildTokenExchangeResponse,
  computeExchangedTokenLifetime,
  parseTokenExchangeParams,
  processTokenExchangeRequest,
  resolveExchangeTarget,
  resolveSubjectToken,
  validateExchangeScope,
  type ParsedTokenExchangeParams,
  type TokenExchangeErrorCode,
  type TokenExchangeGrant,
  type TokenExchangeRequestContext,
  type TokenExchangeResponse,
} from './token-exchange-request.js';
