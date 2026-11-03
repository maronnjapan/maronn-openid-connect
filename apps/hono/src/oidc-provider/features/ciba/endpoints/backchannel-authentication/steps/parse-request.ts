import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'parse',
  label: 'バックチャネル認証リクエストを解析する',
  spec: 'CIBA Core 1.0 §7.1',
  function: 'parseBackchannelAuthenticationRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

/**
 * フォーム形式の `Content-Type` なら true を返す。
 *
 * `contentType`（`Content-Type` ヘッダーの値）の `;` より前を小文字にし、前後の空白を除いてから `application/x-www-form-urlencoded` と比べる。
 * そのため、`charset` などのパラメータが付いていても true を返す。
 * バックチャネル認証リクエストのボディは、この形式でなければならない（CIBA Core 1.0 §7.1 の MUST）。
 *
 * @spec CIBA Core 1.0 §7.1
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * ボディと `Authorization` ヘッダーを読み取って返す。
 *
 * リクエストボディのパラメータを `params` に、`Authorization` ヘッダーの値（ないときは空文字列）を `authorization` に入れて返す。
 *
 * @spec CIBA Core 1.0 §7.1
 * @spec RFC 6749 §3.1
 * @throws {BackchannelAuthenticationEndpointError} `invalid_request`: `Content-Type` が `application/x-www-form-urlencoded` でないとき、または同じパラメータが 2 回以上あるとき（ステータスは 400）。
 */
export async function parseBackchannelAuthenticationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new BackchannelAuthenticationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Backchannel authentication requests must use application/x-www-form-urlencoded' },
    });
  }

  // 同じパラメータの繰り返しは禁じられている（RFC 6749 §3.1 の MUST NOT）ので、ボディを文字列のまま読む。
  // `URLSearchParams` の要素を順にたどれば重複を検出でき、最後の値だけが黙って残ることもない。
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    throw new BackchannelAuthenticationEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };
}
