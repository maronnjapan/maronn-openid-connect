import { type AuthorizationOutcome, type AuthorizationRequestInput, isAuthorizationRequestParams } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'authorize',
  kind: 'parse',
  label: '認可リクエストを解析する',
  spec: 'OIDC Core 1.0 §3.1.2.1 / §13.2',
  function: 'parseAuthorizationRequest',
  consumes: [],
  produces: ['params'],
  removable: false,
});

/**
 * パラメータを集め、重複した名前があればそれも返す。
 *
 * 認可リクエストでは、同じパラメータを繰り返せない（OIDC Core 1.0 §3.1.2.1、RFC 6749 §3.1）。
 * `Object.fromEntries(searchParams)` は重複した名前の最後の値を黙って残すので、`response_type=code&response_type=token` のようなリクエストを通してしまう。
 * そのため、パラメータを一つずつ調べ、すでに出た名前に出会った時点で、そこまでのパラメータと重複した名前（`duplicateKey`）を返す。
 */
function collectUniqueParams(
  searchParams: URLSearchParams,
): { params: Record<string, string>; duplicateKey?: string } {
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      return { params, duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }
  return { params };
}

/**
 * クエリかボディからパラメータを読み取って返す。
 *
 * `POST` ならボディから、それ以外（`GET`）ならクエリから読み取る。
 * `POST` の `Content-Type` が `application/x-www-form-urlencoded` で始まらなければ、`null` を返す。
 * 重複した名前は、`collectUniqueParams()` が `duplicateKey` に入れて返す。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §13.2
 */
async function parseAuthorizationRequestParams(
  c: any,
): Promise<{ params: Record<string, string>; duplicateKey?: string } | null> {
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    // `POST` は `application/x-www-form-urlencoded` で送る必要があるので、そうでなければ `null` を返す（OIDC Core 1.0 §13.2）。
    if (!contentType.toLowerCase().split(';')[0].trim().startsWith('application/x-www-form-urlencoded')) {
      return null;
    }
    // 重複した名前を `URLSearchParams` で見つけられるよう、ボディをそのまま文字列で読む。
    // `parseBody()` は、重複した名前を黙って一つにまとめてしまう。
    const raw = await c.req.text();
    return collectUniqueParams(new URLSearchParams(raw));
  }
  return collectUniqueParams(new URL(c.req.url).searchParams);
}

/**
 * 認可リクエストを解析し、パラメータを返す。
 *
 * 次のリクエストには、パラメータの代わりに `bad_request` の結果（`invalid_request`）を返す。
 * - `POST` で、ボディが `application/x-www-form-urlencoded` でない。
 * - 同じパラメータが繰り返されている。
 * - `client_id` が無い。
 *
 * まだトランザクションが無いので、これらには画面ではなく JSON の OAuth のエラーレスポンスで応答する。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §13.2
 * @spec RFC 6749 §3.1
 */
export async function parseAuthorizationRequest(
  c: any,
): Promise<{ params: AuthorizationRequestInput } | AuthorizationOutcome> {
  const parsed = await parseAuthorizationRequestParams(c);

  if (parsed === null) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: 'Authorization POST requests must use application/x-www-form-urlencoded' };
  }

  // 同じパラメータが繰り返されていれば、`bad_request` の結果を返す（OIDC Core 1.0 §3.1.2.1、RFC 6749 §3.1）。
  if (parsed.duplicateKey !== undefined) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: `Parameter "${parsed.duplicateKey}" must not be repeated` };
  }

  const rawParams = parsed.params;

  if (!isAuthorizationRequestParams(rawParams)) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: 'Missing required parameter: client_id' };
  }

  return { params: rawParams };
}
