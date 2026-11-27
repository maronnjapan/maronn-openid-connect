import { UserInfoEndpointError, type UserInfoChallenges } from '../../../endpoints/userinfo/response.js';
import { step } from '../../../endpoints/step.js';
import { dpopSigningAlgsOf } from '../config.js';
import { ambiguousUserInfoRequestError, userInfoEndpointErrorOf } from '../error-responses.js';
import { DpopError } from '../errors.js';
import { readDpopProofHeader, verifyDpopRequestProof } from '../proof.js';
import {
  DPOP_AUTHENTICATION_SCHEME,
  dpopChallengeOf,
  namesBearerAndDpopSchemes,
  readDpopAuthorization,
  validateDpopCredentials,
} from '../resource.js';
import { provideDpopNonce, resourceServerNonceOf } from '../server-nonce.js';

export const meta = step({
  id: 'read-dpop-access-token',
  endpoint: 'userinfo',
  feature: 'dpop',
  kind: 'parse',
  label: 'DPoP のチャレンジを並べ、DPoP スキームのアクセストークンを読んで DPoP proof を検証する',
  spec: 'RFC 9449 §7.1 / §7.2 / §4.3 / §9',
  function: 'readDpopUserInfoRequest',
  consumes: ['challenges'],
  produces: ['dpopAccessToken', 'dpopJkt'],
  removable: false,
  before: ['parse-access-token'],
});

/**
 * `Authorization: DPoP` で提示されたアクセストークンを読み、一緒に送られた DPoP proof を検証して、トークンとその鍵の JWK Thumbprint を返す。
 *
 * どのリクエストでも、まず `challenges` に、受け付ける alg（`algs`）を並べた DPoP のチャレンジを足す。
 * このステップと後のステップの失敗は、Bearer のチャレンジと並べてこのチャレンジを返す（RFC 9449 §7.1 / §7.2）。
 * Bearer と DPoP の両方でトークンを送ったリクエストは、400 の `invalid_request` で拒否し、どちらのチャレンジにもエラーの情報を入れる（RFC 9449 §7.2 Figure 19）。
 * 両方とは、`Authorization` が二つのスキームを名指す（二つのフィールドを送った）ときと、`Authorization: DPoP` にフォームのボディの `access_token`（Bearer の方法、RFC 6750 §2.2）を添えたときである。
 *
 * DPoP スキームでなければ（Bearer の提示か、トークンがない）、ほかに何もせずに `dpopAccessToken` と `dpopJkt` が `undefined` の結果を返し、後の Bearer のステップに任せる。
 * その失敗のエラーの情報は Bearer のチャレンジが伝え、DPoP のチャレンジはエラーなしで並ぶ（RFC 9449 §7.2 Figure 17 / 18）。
 * DPoP スキームなら、トークンを提示したスキームを DPoP にして、このステップと後のステップの失敗のエラーの情報を DPoP のチャレンジに入れる（RFC 9449 §7.2）。
 * そのうえで、次を確かめる。
 * - POST のフォームのボディに空でない `access_token` がない（あれば、`Authorization` の credentials の形によらず、上の両方のスキームでトークンを送ったリクエストとして拒否する。RFC 6750 §2）
 * - `Authorization` の値がアクセストークンを一つの token68 で持つ（RFC 9449 §7.1）
 * - `DPoP` ヘッダーがちょうど一つある（RFC 9449 §7.1 / §4.3）
 * - DPoP proof が正しい（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はアクセストークンのハッシュ。RFC 9449 §4.3）
 * - 設定が保護されたリソースに nonce を求める（`dpopNonceRequiredAtResourceServer`）なら、DPoP proof の `nonce` が、保護されたリソースが `dpopNonceLifetimeSeconds` 秒の間に発行した nonce である（RFC 9449 §9。認可サーバーの nonce は受け付けない）
 *
 * 設定が保護されたリソースに nonce を求めるときは、これらを確かめる前に、保護されたリソースが今発行した nonce を `DPoP-Nonce` ヘッダーでレスポンスに付ける（`provideDpopNonce()`）。
 * そのため、DPoP スキームのリクエストへの、ここから後のどのレスポンス（成功も、このステップと後のステップの失敗も）にも、次の DPoP proof に入れる nonce が付く（RFC 9449 §8.2 / §9）。
 * トークンがその鍵に束縛されていることは、トークンを取得した後のステップ（`verifyDpopUserInfoAccess()`）が確かめる。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §9
 * @spec RFC 6750 §2
 * @throws {UserInfoEndpointError} 401 の `invalid_dpop_proof`: DPoP proof がないか、受け付けないとき
 * @throws {UserInfoEndpointError} 401 の `use_dpop_nonce`（DPoP のチャレンジにエラーの情報を入れる）: 設定が nonce を求め、DPoP proof の `nonce` が無いか、保護されたリソースが最近発行した nonce でないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`: `Authorization: DPoP` にトークンがないか token68 でないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`（どのチャレンジにもエラーの情報を入れる）: Bearer と DPoP の両方でトークンを送ったとき
 * @throws {UserInfoEndpointError} ボディを読めないとき（チャレンジの付かない 400 の `invalid_request`）
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき、設定が nonce を求め、秘密が 32 バイトより短いか `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function readDpopUserInfoRequest(
  c: any,
  challenges: UserInfoChallenges,
): Promise<{ dpopAccessToken: string | undefined; dpopJkt: string | undefined }> {
  // DPoP スキームも受け付けることを、Bearer で提示したリクエストやトークンのないリクエストの失敗にも示す（RFC 9449 §7.2 Figure 17 / 18）。
  challenges.offered.push(dpopChallengeOf(dpopSigningAlgsOf(c.get('config'))));
  const authorization = c.req.header('Authorization');
  if (namesBearerAndDpopSchemes(authorization)) {
    // どちらのスキームで認証しようとしたのか決まらない（RFC 9449 §7.2 Figure 19）。
    throw ambiguousUserInfoRequestError();
  }
  const credentials = readDpopAuthorization(authorization);
  if (credentials === undefined) return { dpopAccessToken: undefined, dpopJkt: undefined };

  // DPoP スキームで提示したリクエストの失敗は、DPoP のチャレンジがエラーの情報を伝える（RFC 9449 §7.2）。
  challenges.scheme = DPOP_AUTHENTICATION_SCHEME;
  // 設定が保護されたリソースに nonce を求めるなら、このリクエストへのこれから後のどのレスポンスにも、次の DPoP proof に入れる nonce を付ける（RFC 9449 §9 / §8.2）。
  const nonceServer = resourceServerNonceOf(c.get('config'));
  if (nonceServer !== undefined) await provideDpopNonce(c, nonceServer);
  try {
    if (await formBodyHasAccessToken(c)) {
      // フォームのボディのトークンは Bearer の方法（RFC 6750 §2.2）なので、DPoP の credentials の形によらず、二つのスキームでトークンを送ったことになる。
      throw ambiguousUserInfoRequestError();
    }
    const accessToken = validateDpopCredentials(credentials);
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(c.req.header('DPoP'));
    if (proof === undefined) {
      throw new DpopError('invalid_dpop_proof', 'A DPoP proof is required with the DPoP authorization scheme');
    }
    const dpopJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/userinfo', accessToken, nonceServer });
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
