/**
 * What the client registration endpoint answers, and the failure a step
 * answers with a fixed response.
 */

/** What the client registration endpoint answers; respondRegistration() turns it into HTTP. */
export interface RegistrationEndpointResponse {
  status: number;
  body: object | null;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class RegistrationEndpointError extends Error {
  constructor(readonly response: RegistrationEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'client registration endpoint error'));
    this.name = 'RegistrationEndpointError';
  }
}

/**
 * 登録のレスポンスを、キャッシュを禁止して返す。
 *
 * `Cache-Control: no-store` と `Pragma: no-cache` を付け、ステップが指定したヘッダー（`WWW-Authenticate` など）を加える。
 * ボディが `null` ならボディなしで、それ以外は JSON で、指定のステータスコード（登録できたときは 201、失敗したときはエラーのステータスコード）で応答する。
 *
 * @spec RFC 7591 §3.2
 */
export function sendRegistrationResponse(c: any, response: RegistrationEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  if (response.body === null) {
    return c.body(null, response.status);
  }
  return c.json(response.body, response.status);
}
