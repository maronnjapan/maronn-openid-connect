import {
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
} from '@maronn-openid-connect/experimental/par';
import type { ParEndpointResponse } from '../response.js';
import { parConfig } from '../../../config.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'store-request',
  endpoint: 'par',
  feature: 'par',
  kind: 'persist',
  label: '新しい request_uri でリクエストを保存する',
  spec: 'RFC 9126 §2.2 / §7.1',
  function: 'storePushedRequest',
  consumes: ['clientId', 'pushedParams'],
  produces: ['parResponse'],
  removable: false,
});

/**
 * リクエストを保存し、`request_uri` を 201 で返す。
 *
 * 参照値は暗号論的な乱数で作り、`request_uri` は `urn:ietf:params:oauth:request_uri:` に参照値を続けた URN にする（RFC 9126 §2.2、§7.1）。
 * 保存するパラメータの `client_id` は認証したクライアントの ID にし、クライアントの認証情報（`client_secret` など）は保存しない。
 * 有効期間は `parConfig.expiresInSeconds` の秒数で、レスポンスの `expires_in` にもその秒数を返す。
 *
 * @spec RFC 9126 §2.2
 * @spec RFC 9126 §7.1
 */
export async function storePushedRequest(
  c: any,
  clientId: string,
  pushedParams: Record<string, string>,
): Promise<ParEndpointResponse> {
  const parStore = c.get('parStore');
  const record = await createPushedAuthorizationRecord({
    clientId,
    params: pushedParams,
    store: parStore,
    expiresInSeconds: parConfig.expiresInSeconds,
  });
  const response = buildPushedAuthorizationResponse(record);

  // プッシュされたパラメータそのものは、ログに出さない。
  // `login_hint` などの個人情報を含むことがあり、`Authorization` ヘッダーには `client_secret` が含まれる。

  // 201 で `request_uri` と `expires_in` を返す（RFC 9126 §2.2）。
  return { status: 201, body: { request_uri: response.requestUri, expires_in: response.expiresIn } };
}
