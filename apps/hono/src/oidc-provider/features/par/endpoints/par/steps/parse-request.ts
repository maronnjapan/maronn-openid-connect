import { sanitizeErrorDescription } from '@maronn-openid-connect/core';
import { ParEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'par',
  feature: 'par',
  kind: 'parse',
  label: 'プッシュされた認可リクエストを解析する',
  spec: 'RFC 9126 §2.1 / RFC 6749 §3.1',
  function: 'parsePushedAuthorizationRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

/**
 * フォーム形式のメディアタイプなら true を返す。
 *
 * `Content-Type` の値の `;` より前の部分を小文字にして `application/x-www-form-urlencoded` と比べるので、`charset` などのパラメータが付いていても true を返す。
 * プッシュされた認可リクエストのボディは `application/x-www-form-urlencoded` でなければならない（RFC 9126 §2.1）。
 *
 * @spec RFC 9126 §2.1
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * パラメータと `Authorization` ヘッダーの値を返す。
 *
 * ボディが `application/x-www-form-urlencoded` でなければ、400 の `invalid_request` を投げる（RFC 9126 §2.1）。
 * 同じ名前のパラメータが 2 回以上あるときも、400 の `invalid_request` を投げる（RFC 6749 §3.1）。
 * `Authorization` ヘッダーがなければ、その値として空文字列を返す。
 *
 * @spec RFC 9126 §2.1
 * @spec RFC 6749 §3.1
 * @throws {ParEndpointError} 400 の `invalid_request`: ボディがフォームの形式でないとき、または同じパラメータが繰り返されたとき
 */
export async function parsePushedAuthorizationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new ParEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' },
    });
  }

  // 生のボディを読み、`URLSearchParams` で順にたどって、繰り返されたパラメータを見つける。
  // リクエストのパラメータは繰り返してはならない（RFC 6749 §3.1）ので、最後の値だけを黙って残す読み方はしない。
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
    throw new ParEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };
}
