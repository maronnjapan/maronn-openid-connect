import { UserInfoEndpointError, type UserInfoChallenges } from '../../../endpoints/userinfo/response.js';
import { step } from '../../../endpoints/step.js';
import { dpopSigningAlgsOf } from '../config.js';
import { userInfoEndpointErrorOf } from '../error-responses.js';
import { DpopError } from '../errors.js';
import { readDpopProofHeader, verifyDpopRequestProof } from '../proof.js';
import { DPOP_AUTHENTICATION_SCHEME, dpopChallengeOf, readDpopAuthorization, validateDpopCredentials } from '../resource.js';

export const meta = step({
  id: 'read-dpop-access-token',
  endpoint: 'userinfo',
  feature: 'dpop',
  kind: 'parse',
  label: 'DPoP スキームのアクセストークンを読み、DPoP proof を検証する',
  spec: 'RFC 9449 §7.1 / §4.3',
  function: 'readDpopUserInfoRequest',
  consumes: ['challenges'],
  produces: ['dpopAccessToken', 'dpopJkt'],
  removable: false,
  before: ['parse-access-token'],
});

/**
 * `Authorization: DPoP` で提示されたアクセストークンを読み、一緒に送られた DPoP proof を検証して、トークンとその鍵の JWK Thumbprint を返す。
 *
 * DPoP スキームでなければ（Bearer の提示か、トークンがない）、何もせずに `dpopAccessToken` と `dpopJkt` が `undefined` の結果を返し、後の Bearer のステップに任せる。
 * DPoP スキームなら、まず `challenges` に、受け付ける alg（`algs`）を並べた DPoP のチャレンジを足し、トークンを提示したスキームを DPoP にする。
 * このステップと後のステップの失敗は、エラーの情報をそのチャレンジに入れて応答する（RFC 9449 §7.1 / §7.2）。
 * そのうえで、次を確かめる。
 * - `Authorization` の値がアクセストークンを一つの token68 で持つ（RFC 9449 §7.1）
 * - POST のフォームのボディに `access_token` がない（トークンを送る方法は一つだけ。RFC 6750 §2）
 * - `DPoP` ヘッダーがちょうど一つある（RFC 9449 §7.1 / §4.3）
 * - DPoP proof が正しい（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はアクセストークンのハッシュ。RFC 9449 §4.3）
 *
 * トークンがその鍵に束縛されていることは、トークンを取得した後のステップ（`verifyDpopUserInfoAccess()`）が確かめる。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §4.3
 * @spec RFC 6750 §2
 * @throws {UserInfoEndpointError} 401 の `invalid_dpop_proof`: DPoP proof がないか、受け付けないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`: `Authorization: DPoP` にトークンがないか token68 でないとき、二つの方法でトークンを送ったとき
 * @throws {UserInfoEndpointError} ボディを読めないとき（チャレンジの付かない 400 の `invalid_request`）
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function readDpopUserInfoRequest(
  c: any,
  challenges: UserInfoChallenges,
): Promise<{ dpopAccessToken: string | undefined; dpopJkt: string | undefined }> {
  const credentials = readDpopAuthorization(c.req.header('Authorization'));
  if (credentials === undefined) return { dpopAccessToken: undefined, dpopJkt: undefined };

  // DPoP スキームで提示したリクエストの失敗は、DPoP のチャレンジがエラーの情報を伝える（RFC 9449 §7.2）。
  challenges.offered.push(dpopChallengeOf(dpopSigningAlgsOf(c.get('config'))));
  challenges.scheme = DPOP_AUTHENTICATION_SCHEME;
  try {
    const accessToken = validateDpopCredentials(credentials);
    if (await formBodyHasAccessToken(c)) {
      throw new DpopError('invalid_request', 'Multiple access token methods are not allowed');
    }
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(c.req.header('DPoP'));
    if (proof === undefined) {
      throw new DpopError('invalid_dpop_proof', 'A DPoP proof is required with the DPoP authorization scheme');
    }
    const dpopJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/userinfo', accessToken });
    return { dpopAccessToken: accessToken, dpopJkt };
  } catch (error) {
    throw userInfoEndpointErrorOf(error);
  }
}

/**
 * POST のフォームのボディの `access_token` パラメータに、空でない値が一つでもあるかを返す。
 *
 * メディアタイプが `application/x-www-form-urlencoded` の POST だけを読む。
 * パラメータを繰り返したボディ（RFC 6750 §3.1 の `invalid_request`）も、値のどれかが空でなければ、二つ目のトークンを送ったとみなす。
 * DPoP スキームのリクエストでは Bearer のステップがボディを読まないので、ボディを読むのはこの一回だけである。
 *
 * @spec RFC 6750 §2.2
 * @throws {UserInfoEndpointError} ボディを読めないとき（チャレンジの付かない 400 の `invalid_request`。Bearer のステップと同じ）
 */
async function formBodyHasAccessToken(c: any): Promise<boolean> {
  if (c.req.method !== 'POST') return false;
  const mediaType = (c.req.header('Content-Type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mediaType !== 'application/x-www-form-urlencoded') return false;
  let body: string;
  try {
    body = await c.req.text();
  } catch {
    throw new UserInfoEndpointError({ status: 400, body: { error: 'invalid_request' } });
  }
  return new URLSearchParams(body).getAll('access_token').some((value) => value !== '');
}
