/**
 * JWT Response for OAuth Token Introspection (RFC 9701) — 呼び出し元 audience 制限。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * RFC 9701 §3: AS は「リソースサーバーがそのアクセストークンの audience で
 * あるか」を判定できなければならない（MUST）。§5: トークンが呼び出し元 RS
 * 宛でない場合、`token_introspection.active` を false にし、他のメンバーを
 * 含めてはならない（MUST NOT）。
 *
 * この制限は JWT 応答経路にのみ適用する。Accept で JWT を要求しない従来の
 * RFC 7662 JSON 応答には適用せず、既存利用者のイントロスペクション挙動を
 * 変えない（JSON 経路の呼び出し元認可は core 側の将来フックの責務）。
 */
import {
  INACTIVE_INTROSPECTION_RESPONSE,
  type IntrospectionResponse,
} from '@maronn-openid-connect/core';

/**
 * イントロスペクション応答を、認証済み呼び出し元へ開示できる形に制限する。
 *
 * `active: true` の応答をそのまま返すのは、呼び出し元の client_id が
 * 「トークンの発行先（`client_id` メンバー）」または「トークンの `aud`
 * メンバー（文字列または配列）」に一致する場合のみ。どちらにも該当しない
 * 場合は `{ active: false }` に置き換え、制限が働いたことを応答から区別
 * させない（RFC 7662 §2.2 の「存在しないトークンと区別させない」原則と
 * 同じオラクル防止）。`active: false` の応答は常にそのまま返す。
 *
 * 入力オブジェクトは変更しない（純関数）。
 */
export function restrictIntrospectionResponseToCaller(
  response: IntrospectionResponse,
  callerClientId: string,
): IntrospectionResponse {
  if (!response.active) {
    return response;
  }
  if (response.client_id === callerClientId) {
    return response;
  }
  if (response.aud === callerClientId) {
    return response;
  }
  if (Array.isArray(response.aud) && response.aud.includes(callerClientId)) {
    return response;
  }
  return INACTIVE_INTROSPECTION_RESPONSE;
}
