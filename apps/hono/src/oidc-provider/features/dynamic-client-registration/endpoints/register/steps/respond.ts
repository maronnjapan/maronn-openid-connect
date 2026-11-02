import {
  type DynamicallyRegisteredClient,
  buildClientRegistrationResponse,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { sendRegistrationResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'respond',
  label: 'Respond 201 with the registration response',
  spec: 'RFC 7591 §3.2.1',
  function: 'respondRegistration',
  consumes: ['client'],
  produces: [],
  removable: false,
});

/**
 * 登録したクライアントの情報を 201 で返す。
 *
 * ボディには、発行した値（`client_id`、`client_id_issued_at`、発行したときは `client_secret` と `client_secret_expires_at`）と、登録したすべてのメタデータ（既定値を適用したもの）を含める（RFC 7591 §3.2.1）。
 * `client_secret_expires_at` の 0 は、シークレットに有効期限がないことを表す。
 * ボディに `client_secret` が含まれることがあるので、キャッシュを禁止して返す。
 *
 * @spec RFC 7591 §3.2.1
 */
export function respondRegistration(c: any, client: DynamicallyRegisteredClient): Response {
  return sendRegistrationResponse(c, { status: 201, body: buildClientRegistrationResponse(client) });
}
