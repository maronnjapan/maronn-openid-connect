/**
 * What the backchannel authentication endpoint answers, and the failure a
 * step answers with a fixed response.
 */

/** What the backchannel authentication endpoint answers; respondBackchannelAuthentication() turns it into HTTP. */
export interface BackchannelAuthenticationEndpointResponse {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class BackchannelAuthenticationEndpointError extends Error {
  constructor(readonly response: BackchannelAuthenticationEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'backchannel authentication endpoint error'));
    this.name = 'BackchannelAuthenticationEndpointError';
  }
}

/**
 * レスポンスにキャッシュを禁じるヘッダーを設定する。
 *
 * リクエストコンテキスト `c` に、`Cache-Control: no-store` と `Pragma: no-cache` を設定する。
 * `auth_req_id` はトークンの取得に使う秘密の値なので、このエンドポイントの応答はトークンレスポンスの規則に従う。
 *
 * @spec RFC 6749 §5.1
 * @spec RFC 6749 §5.2
 */
export function noStore(c: any): void {
  // `auth_req_id` はトークンの取得に使う秘密の値なので、トークンレスポンスと同じくキャッシュを禁じる（RFC 6749 §5.1、§5.2）。
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}
