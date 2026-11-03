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
 * 呼び出し元宛てでなければ `{ active: false }` を返す。
 *
 * `active` が true のレスポンスは、認証済みの呼び出し元の `client_id`（`callerClientId`）が、トークンの発行先（`client_id` メンバー）か `aud` メンバー（文字列か配列）に一致するときだけ、そのまま返す。
 * どちらにも一致しなければ、`INACTIVE_INTROSPECTION_RESPONSE`（`{ active: false }`）を返す。
 * `active` が false のレスポンスは、常にそのまま返す。
 * 受け取ったオブジェクトは変更しない。
 *
 * 一致しないときに `{ active: false }` だけを返すのは、制限で隠したレスポンスを、存在しないトークンのレスポンスと区別できないようにするためである（RFC 7662 §2.2 と同じ考え方）。
 * 区別できると、呼び出し元は、ほかのクライアント宛てのトークンが有効であるかどうかを、レスポンスの違いから推測できる。
 *
 * @spec RFC 9701 §5
 * @spec RFC 7662 §2.2
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
