import {
  parseClientRegistrationBody,
  type ParsedClientRegistration,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'parse-request',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'parse',
  label: 'Read the JSON metadata',
  spec: 'RFC 7591 §3.1',
  function: 'parseRegistrationRequest',
  consumes: [],
  produces: ['registration'],
  removable: false,
});

/**
 * メディアタイプが `application/json` なら true を返す。
 *
 * `Content-Type` の値の `;` より前の部分を小文字にして比べるので、`charset` などのパラメータが付いていても true を返す。
 * 登録リクエストのボディは `application/json` でなければならない（RFC 7591 §3.1）。
 *
 * @spec RFC 7591 §3.1
 */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/**
 * JSON のボディからメタデータを読み取って返す。
 *
 * 登録リクエストのボディは `application/json` でなければならない（RFC 7591 §3.1）。
 * `charset` などのパラメータは付いていてもよい。
 * メディアタイプを限ると、CORS のプリフライトなしで送れる別オリジンの `text/plain` のフォーム送信で、JSON の形をしたボディを作られることも防げる。
 *
 * `Content-Length` が `maxRegistrationBodyBytes` より大きい値を宣言していれば、ボディを読む前に拒否するので、大きすぎるリクエストをメモリに読み込まずに済む。
 * ヘッダーの値は偽れるので、最終的な判定は、ボディそのものの UTF-8 のバイト数で `parseClientRegistrationBody()` が行う。
 * `parseClientRegistrationBody()` は JSON の形も確かめ、`software_statement`（RFC 7591 §2.3）をそれ以外のメタデータから分けて、次のステップに渡す。
 *
 * @spec RFC 7591 §3.1
 * @throws {RegistrationEndpointError} 400 の `invalid_client_metadata`: `Content-Type` が `application/json` でないとき、または `Content-Length` が上限を超えるとき
 * @throws {ClientRegistrationError} `invalid_client_metadata`: ボディが上限のバイト数を超えるとき、JSON として読めないとき、JSON のオブジェクトでないとき
 * @throws {ClientRegistrationError} `invalid_software_statement`: `software_statement` が文字列でないとき
 */
export async function parseRegistrationRequest(c: any): Promise<ParsedClientRegistration> {
  if (!isJson(c.req.header('Content-Type') ?? '')) {
    throw new RegistrationEndpointError({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
    });
  }
  const config = c.get('dynamicClientRegistrationConfig');
  const declaredLength = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > config.maxRegistrationBodyBytes) {
    throw new RegistrationEndpointError({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'request body must not exceed the configured maximum size' },
    });
  }
  const rawBody = await c.req.text();
  return parseClientRegistrationBody(rawBody, { maxBodyBytes: config.maxRegistrationBodyBytes });
}
