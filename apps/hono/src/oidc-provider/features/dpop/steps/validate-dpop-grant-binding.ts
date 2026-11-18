import { readDpopJkt, validateDpopBoundGrant } from '@maronn-openid-connect/dpop';
import type { TokenRequestBody } from '../../../endpoints/token/response.js';
import { step } from '../../../endpoints/step.js';
import { tokenEndpointErrorOf } from '../errors.js';

export const meta = step({
  id: 'validate-dpop-grant-binding',
  endpoint: 'token',
  feature: 'dpop',
  kind: 'validate',
  label: '認可コードとリフレッシュトークンを束縛した鍵を確かめる',
  spec: 'RFC 9449 §5 / §10',
  function: 'validateDpopGrantBinding',
  calls: ['authCodeStore.get', 'refreshTokenStore.get'],
  consumes: ['params', 'authenticatedClientId', 'dpopJkt'],
  produces: [],
  removable: false,
  after: ['verify-dpop-proof'],
  before: ['validate-grant-type'],
});

/**
 * 提示された認可コードかリフレッシュトークンが DPoP の鍵に束縛されていれば、DPoP proof が同じ鍵のものであることを確かめる。
 *
 * 認可コードは、認可リクエストの `dpop_jkt`（PAR では `DPoP` ヘッダーの鍵）に束縛されている（RFC 9449 §10）。
 * リフレッシュトークンは、パブリッククライアントが DPoP proof を送って得たときに束縛されている（RFC 9449 §5）。
 * 束縛した鍵はレコードの `cnf.jkt` にあり、DPoP proof がないか、別の鍵の DPoP proof なら `invalid_grant` で拒否する。
 *
 * 認可コードとリフレッシュトークンを検証して使用済みにするステップより前に実行し、別の鍵のリクエストではコードやトークンを使用済みにしない。
 * 使用済みのもの、別のクライアントのもの、見つからないものは確かめず、後のグラントの検証に任せる。
 * 使用済みのコードやトークンの再提示は、グラントの検証がそのグラントのトークンを失効させる（OAuth 2.1 §4.1.2 / §4.3.1）ので、ここで先に拒否しない。
 *
 * @spec RFC 9449 §5
 * @spec RFC 9449 §10
 * @throws {TokenEndpointError} 400 の `invalid_grant`: 束縛した鍵と DPoP proof の鍵が合わないとき
 */
export async function validateDpopGrantBinding(
  c: any,
  params: TokenRequestBody,
  authenticatedClientId: string,
  dpopJkt: string | undefined,
): Promise<void> {
  const record = await boundGrantRecordOf(c, params);
  if (record === undefined || record.used || record.clientId !== authenticatedClientId) return;
  try {
    validateDpopBoundGrant(readDpopJkt(record), dpopJkt);
  } catch (error) {
    throw tokenEndpointErrorOf(error);
  }
}

/**
 * トークンリクエストが提示した認可コードかリフレッシュトークンの、保存したレコードを返す。
 *
 * `grant_type` が `authorization_code` なら `code` の、`refresh_token` なら `refresh_token` のレコードを返す。
 * ほかのグラントと、見つからないものには `undefined` を返す。
 */
async function boundGrantRecordOf(
  c: any,
  params: TokenRequestBody,
): Promise<{ used: boolean; clientId: string } | undefined> {
  if (params.grant_type === 'authorization_code' && typeof params.code === 'string') {
    return (await c.get('authCodeStore').get(params.code)) ?? undefined;
  }
  if (params.grant_type === 'refresh_token' && typeof params.refresh_token === 'string') {
    return (await c.get('refreshTokenStore').get(params.refresh_token)) ?? undefined;
  }
  return undefined;
}
