import { validatePushedAuthorizationParams } from '@maronn-openid-connect/experimental/par';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-request',
  endpoint: 'par',
  feature: 'par',
  kind: 'validate',
  label: '/authorize と同じ規則でリクエストを検証する',
  spec: 'RFC 9126 §2.1',
  function: 'validatePushedRequest',
  consumes: ['pushedParams'],
  produces: [],
  removable: false,
});

/**
 * パラメータを、認可エンドポイントと同じ規則で検証する。
 *
 * 認可サーバーは、認可エンドポイントに送られた認可リクエストと同じようにリクエストを検証しなければならない（RFC 9126 §2.1）。
 * そのため、登録されていない `redirect_uri` や不正な `scope` は、エンドユーザーが画面を見る前にここで拒否する。
 * PKCE を省いたリクエストを許すかどうかは、認可エンドポイントと同じ `allowNonPkceAuthorizationCodeFlow` の設定に従う。
 *
 * @spec RFC 9126 §2.1
 * @throws {ParError} `invalid_request`、`invalid_scope`、`unauthorized_client`、`unsupported_response_type`: 認可エンドポイントが拒否するパラメータがあるとき
 */
export async function validatePushedRequest(c: any, pushedParams: Record<string, string>): Promise<void> {
  const clientResolver = c.get('clientResolver');
  const config = c.get('config');
  await validatePushedAuthorizationParams(pushedParams, clientResolver, {
    allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
  });
}
