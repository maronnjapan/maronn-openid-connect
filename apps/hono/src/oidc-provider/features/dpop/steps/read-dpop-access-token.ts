import type { UserInfoChallenge } from '../../../endpoints/userinfo/response.js';
import { step } from '../../../endpoints/step.js';
import { dpopSigningAlgsOf } from '../config.js';
import { userInfoEndpointErrorOf } from '../error-responses.js';
import { DpopError } from '../errors.js';
import { readDpopProofHeader, verifyDpopRequestProof } from '../proof.js';
import { readDpopAuthorization } from '../resource.js';

export const meta = step({
  id: 'read-dpop-access-token',
  endpoint: 'userinfo',
  feature: 'dpop',
  kind: 'parse',
  label: 'DPoP スキームのアクセストークンを読み、DPoP proof を検証する',
  spec: 'RFC 9449 §7.1 / §4.3',
  function: 'readDpopUserInfoRequest',
  consumes: [],
  produces: ['dpopAccessToken', 'dpopJkt', 'dpopChallenge'],
  removable: false,
  before: ['parse-access-token'],
});

/** What readDpopUserInfoRequest() read: all undefined when the token is not presented with the DPoP scheme. */
export interface DpopUserInfoRequest {
  /** The access token of `Authorization: DPoP <token>`. */
  dpopAccessToken?: string;
  /** The JWK Thumbprint of the key of the verified DPoP proof. */
  dpopJkt?: string;
  /** The DPoP challenge the failures of the later steps answer with. */
  dpopChallenge?: UserInfoChallenge;
}

/**
 * `Authorization: DPoP` で提示されたアクセストークンを読み、一緒に送られた DPoP proof を検証して、その鍵の JWK Thumbprint を返す。
 *
 * DPoP スキームでなければ（Bearer の提示か、トークンがない）、何もせずにすべて `undefined` の結果を返し、後の Bearer のステップに任せる。
 * DPoP スキームなら、次を確かめる。
 * - `DPoP` ヘッダーがちょうど一つある（RFC 9449 §7.1 / §4.3）
 * - POST のフォームのボディに `access_token` がない（トークンを送る方法は一つだけ。RFC 6750 §2）
 * - DPoP proof が正しい（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はアクセストークンのハッシュ。RFC 9449 §4.3）
 *
 * 後のステップの失敗も DPoP のチャレンジで応答するよう、受け付ける alg（`algs`）付きの DPoP のチャレンジを返す（RFC 9449 §7.1）。
 * トークンがその鍵に束縛されていることは、トークンを取得した後のステップ（`verifyDpopUserInfoAccess()`）が確かめる。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §4.3
 * @spec RFC 6750 §2
 * @throws {UserInfoEndpointError} 401 の `invalid_dpop_proof`: DPoP proof がないか、受け付けないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`: DPoP スキームにトークンがないとき、二つの方法でトークンを送ったとき
 */
export async function readDpopUserInfoRequest(c: any): Promise<DpopUserInfoRequest> {
  const algs = dpopSigningAlgsOf(c.get('config'));
  try {
    const accessToken = readDpopAuthorization(c.req.header('Authorization'));
    if (accessToken === undefined) return {};
    if (await formBodyHasAccessToken(c)) {
      throw new DpopError('invalid_request', 'Multiple access token methods are not allowed');
    }
    const proof = readDpopProofHeader(c.req.header('DPoP'));
    if (proof === undefined) {
      throw new DpopError('invalid_dpop_proof', 'A DPoP proof is required with the DPoP authorization scheme');
    }
    const dpopJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/userinfo', accessToken });
    return { dpopAccessToken: accessToken, dpopJkt, dpopChallenge: { scheme: 'DPoP', parameters: `algs="${algs.join(' ')}"` } };
  } catch (error) {
    throw userInfoEndpointErrorOf(error, algs);
  }
}

/**
 * POST のフォームのボディが `access_token` パラメータを持つかを返す。
 *
 * メディアタイプが `application/x-www-form-urlencoded` の POST だけを読む。
 * DPoP スキームのリクエストでは Bearer のステップがボディを読まないので、ボディを読むのはこの一回だけである。
 *
 * @spec RFC 6750 §2.2
 */
async function formBodyHasAccessToken(c: any): Promise<boolean> {
  if (c.req.method !== 'POST') return false;
  const mediaType = (c.req.header('Content-Type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mediaType !== 'application/x-www-form-urlencoded') return false;
  return new URLSearchParams(await c.req.text()).has('access_token');
}
