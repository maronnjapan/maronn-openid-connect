import { authenticateParClient, rejectForbiddenParParams } from '@maronn-openid-connect/experimental/par';
import { verifyPresentedClientCredential } from '../../../../../client-auth.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'authenticate-client',
  endpoint: 'par',
  feature: 'par',
  kind: 'validate',
  label: 'プッシュしたクライアントを認証する',
  spec: 'RFC 9126 §2.1',
  function: 'authenticatePushingClient',
  consumes: ['params', 'authorization'],
  produces: ['clientId', 'pushedParams'],
  removable: false,
});

/**
 * クライアントを認証し、その ID とパラメータを返す。
 *
 * 認証の前に、プッシュされた認可リクエストに含めてはならないパラメータ（`request_uri` と `request`）を拒否する。
 * クライアントの認証は、トークンエンドポイントとまったく同じ規則で行う（パブリッククライアントは `client_id` だけを送る）。
 * `private_key_jwt` のクライアントアサーションの `aud` には、このエンドポイントの URL か issuer を求める。
 * 認証に使ったクライアントアサーション（`client_assertion_type` と `client_assertion`）は、プッシュするパラメータに残さない。
 *
 * `client_id` は認可リクエストの必須のパラメータなので、検証の前に、返すパラメータの `client_id` を認証したクライアントの ID に置き換える。
 *
 * @spec RFC 9126 §2.1
 * @throws {ParError} `invalid_request`: `request_uri` か `request` を含むとき、または認証情報の送り方が正しくないとき
 * @throws {ParError} `invalid_client`: クライアントの認証に失敗したとき
 */
export async function authenticatePushingClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<{ clientId: string; pushedParams: Record<string, string> }> {
  const clientResolver = c.get('clientResolver');

  // `request_uri` か `request` を含むリクエストを、`invalid_request` で拒否する。
  // `request_uri` はプッシュしてはならず（RFC 9126 §2.1 の MUST NOT）、`request` パラメータ（リクエストオブジェクトとの併用、RFC 9126 §3）にはこの生成された OP が対応していない。
  rejectForbiddenParParams(params);

  const clientId = await authenticateParClient({
    params,
    authorizationHeader: authorization,
    clientResolver,
    verifyCredential: (client, presented) => verifyPresentedClientCredential(c, client, presented, '/par'),
  });

  // クライアントアサーションは認証に使い終えた認証情報なので、保存するパラメータから除く。
  const { client_assertion_type: _assertionType, client_assertion: _assertion, ...requestParams } = params;
  return { clientId, pushedParams: { ...requestParams, client_id: clientId } };
}
