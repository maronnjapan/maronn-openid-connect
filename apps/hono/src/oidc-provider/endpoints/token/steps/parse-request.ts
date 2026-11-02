import type { TokenRequestParams } from '@maronn-openid-connect/core';
import { type TokenRequestBody, TokenEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'token',
  kind: 'parse',
  label: 'Parse the token request',
  spec: 'RFC 6749 §4.1.3 / §3.2',
  function: 'parseTokenRequest',
  consumes: [],
  produces: ['params', 'authorization'],
  removable: false,
});

/**
 * パラメータの `grant_type` が文字列なら true を返す。
 *
 * true のとき、TypeScript はパラメータを `TokenRequestParams` として扱う（型の絞り込み）。
 * オブジェクトでない値と、必須の `grant_type` がない値には false を返す。
 */
function isTokenRequestParams(
  params: unknown,
): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['grant_type'] === 'string';
}

/**
 * `Content-Type` がフォームの形式なら true を返す。
 *
 * トークンリクエストのボディは `application/x-www-form-urlencoded` でなければならない（MUST）。
 * メディアタイプは大文字と小文字を区別せず（RFC 9110 §8.3.1）、`; charset=UTF-8` のようなパラメータが付くことがあるので、値を小文字にし、最初の `;` から後ろを捨ててから比べる。
 *
 * @spec RFC 6749 §4.1.3
 * @spec RFC 6749 付録 B
 * @spec OIDC Core 1.0 §3.1.3.1
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * ボディと `Authorization` ヘッダーを読み取って返す。
 *
 * ボディはフォームの形式（`application/x-www-form-urlencoded`）として読み、パラメータの名前と値の組にして返す。
 * `Authorization` ヘッダーがなければ、空文字列を返す。
 *
 * 次のリクエストは、トークンのパラメータとして使う前に、`TokenEndpointError`（400、`invalid_request`）を投げて拒否する。
 * - ボディが `application/x-www-form-urlencoded` でない。
 * - 同じパラメータが繰り返されている。
 * - `grant_type` がない。
 *
 * @spec RFC 6749 §4.1.3
 * @spec RFC 6749 §3.2
 * @spec OIDC Core 1.0 §3.1.3.1
 */
export async function parseTokenRequest(
  c: any,
): Promise<{ params: TokenRequestBody; authorization: string }> {
  // ボディが `application/x-www-form-urlencoded` でなければ（`multipart/form-data` や `application/json` など）、解析する前に `invalid_request` で拒否する（RFC 6749 §4.1.3、OIDC Core 1.0 §3.1.3.1）。
  // 解析する前に拒否するので、フォームでないボディがトークンのパラメータとして使われることはない。
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded' },
    });
  }

  // 同じパラメータが繰り返されていたら、`invalid_request` で拒否する（RFC 6749 §3.2）。
  // `parseBody()` は繰り返された値を黙って最後の一つにしてしまうので、生のボディを `URLSearchParams` で順に読み、重複した名前を見つける。
  const rawBody = await c.req.text();
  const searchParams = new URLSearchParams(rawBody);
  const rawParams: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    rawParams[key] = value;
  }
  const authorization = c.req.header('Authorization') ?? '';

  if (duplicateKey !== undefined) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: `Parameter "${duplicateKey}" must not be repeated` },
    });
  }

  if (!isTokenRequestParams(rawParams)) {
    throw new TokenEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Missing required parameter: grant_type' },
    });
  }

  return { params: rawParams, authorization };
}
