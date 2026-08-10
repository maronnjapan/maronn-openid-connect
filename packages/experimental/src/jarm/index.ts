/**
 * JWT Secured Authorization Response Mode (JARM) — OpenID Foundation Final
 * Specification (2022-11-09)
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で `--enable jarm` を
 * 明示したときのみ生成コードから利用される。
 *
 * 初期スコープは `query.jwt`（と省略形 `jwt`）の**署名のみ**に限定する。
 * `fragment.jwt` / `form_post.jwt`（§2.3.2 / §2.3.3）・応答 JWT の暗号化（JWE,
 * §2.2）・クライアント別 `authorization_signed_response_alg`（§3）は非対応。
 */
export {
  JARM_RESPONSE_PARAM,
  JARM_SUPPORTED_RESPONSE_MODES,
  resolveJarmResponseMode,
  type JarmResponseModeResolution,
} from './response-mode.js';

export {
  assertJarmLifetimeSeconds,
  buildJarmRedirectUrl,
  createJarmResponseJwt,
} from './response-jwt.js';

/**
 * core の `AuthTransaction`（closed interface）に JARM モードを相乗りさせるための
 * 交差型。
 *
 * 生成コードは transaction を store へ put するときに
 * `{ ...transaction, jarmResponseMode: 'query.jwt' }` を保存し、get 後にこの型
 * として読む。**auth transaction store の実装は未知フィールドを透過的に保存する
 * 必要がある**（契約要件。オブジェクトを丸ごと JSON 化する通常の実装なら自然に
 * 満たされる。フィールドを列挙してコピーする実装ではこの記録が失われ、JARM を
 * 要求したクライアントへ静かに平文クエリで応答してしまう）。
 */
export type JarmAuthTransactionFields = {
  /** JARM モードで応答すべきトランザクションであることの記録。無指定は平文応答。 */
  jarmResponseMode?: 'query.jwt';
};
