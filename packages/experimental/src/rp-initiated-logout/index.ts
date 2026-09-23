/**
 * OpenID Connect RP-Initiated Logout 1.0 — Final (2022-09-12)
 *
 * **Experimental**: この機能の API は安定していない。マイナーリリースでも
 * 破壊的に変更されることがある。本番運用の前に
 * `docs/library-document` の Experimental セクションを確認すること。
 *
 * `@maronn-openid-connect/core` とは別 package であり、CLI で
 * `--enable rp-initiated-logout` を明示したときのみ生成コードから利用される。
 *
 * このモジュールは「ログアウト要求の解釈とリダイレクト先の確定」だけを持つ
 * 純関数群で、HTTP にもセッションストアにも触れない。`id_token_hint` の検証は
 * core 公開の `validateIdTokenHint` を使い、セッションの実体（Cookie とストア）は
 * 生成コード側の責務のまま変えない。
 *
 * スコープ外（非目標）: Session Management 1.0 / Front-Channel Logout 1.0 /
 * Back-Channel Logout 1.0（他 RP への伝播）、期限切れ `id_token_hint` の受理
 * （§2 の SHOULD。本実装は無効なヒントとして確認画面の経路に落とす）。
 */
export {
  parseEndSessionRequest,
  extractIdTokenHintAudience,
  type EndSessionRequest,
} from './request.js';

export { decideLogoutFlow, type LogoutDecision } from './decision.js';

export { resolvePostLogoutRedirect } from './redirect.js';
