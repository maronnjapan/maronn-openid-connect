/**
 * What the revocation endpoint answers, and the failure a step answers with a
 * fixed response.
 */

/** What the revocation endpoint answers on a failure; respondRevocationError() turns it into HTTP. */
export interface RevocationEndpointResponse {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class RevocationEndpointError extends Error {
  constructor(readonly response: RevocationEndpointResponse) {
    const details = response.body as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'revocation endpoint error'));
    this.name = 'RevocationEndpointError';
  }
}

/**
 * レスポンスにキャッシュを禁じるヘッダーを設定する。
 *
 * リクエストコンテキストに `Cache-Control: no-store` と `Pragma: no-cache` を設定し、失効エンドポイントのレスポンスをキャッシュさせない。
 *
 * @spec RFC 7009 §2.2
 */
export function noStore(c: any): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}
