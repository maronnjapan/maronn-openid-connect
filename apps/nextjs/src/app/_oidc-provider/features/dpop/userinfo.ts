/**
 * EXTENSION (dpop): the blocks of userinfo/route.ts (RFC 9449 §7).
 *
 * The UserInfo endpoint calls readDpopUserInfoRequest() in its
 * [read-dpop-access-token] block, before the Bearer token is read, and
 * verifyDpopUserInfoAccess() in its [verify-dpop-access-token] block, once
 * the token is resolved. A failure is a UserInfoEndpointError, which the
 * [respond-error] block answers with the challenges of the route: Bearer and
 * the DPoP challenge that readDpopUserInfoRequest() adds. The DPoP challenge
 * carries the error of a token presented with the DPoP scheme, the Bearer
 * challenge that of a Bearer token, and both that of a request that sends its
 * token with both schemes.
 */
import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { UserInfoEndpointError, type UserInfoChallenges } from '../../../userinfo/response';
import { config } from '../../provider';
import { readDpopJkt } from './binding';
import { dpopSigningAlgsOf } from './config';
import { ambiguousUserInfoRequestError, userInfoEndpointErrorOf } from './error-responses';
import { DpopError } from './errors';
import { readDpopProofHeader, verifyDpopRequestProof } from './proof';
import {
  DPOP_AUTHENTICATION_SCHEME,
  dpopChallengeOf,
  namesBearerAndDpopSchemes,
  readDpopAuthorization,
  validateDpopAccessTokenBinding,
  validateDpopCredentials,
} from './resource';

/** What readDpopUserInfoRequest() read: both undefined when the token is not presented with the DPoP scheme. */
export interface DpopUserInfoRequest {
  /** The access token of `Authorization: DPoP <token>`. */
  dpopAccessToken: string | undefined;
  /** The JWK Thumbprint of the key of the verified DPoP proof. */
  dpopJkt: string | undefined;
}

/**
 * `Authorization: DPoP` で提示されたアクセストークンを読み、一緒に送られた DPoP proof を検証して、トークンとその鍵の JWK Thumbprint を返す。
 *
 * どのリクエストでも、まず `challenges` に、受け付ける alg（`algs`）を並べた DPoP のチャレンジを足す。
 * このブロックと後のブロックの失敗は、Bearer のチャレンジと並べてこのチャレンジを返す（RFC 9449 §7.1 / §7.2）。
 * Bearer と DPoP の両方でトークンを送ったリクエストは、400 の `invalid_request` で拒否し、どちらのチャレンジにもエラーの情報を入れる（RFC 9449 §7.2 Figure 19）。
 * 両方とは、`Authorization` が二つのスキームを名指す（二つのフィールドを送った）ときと、`Authorization: DPoP` にフォームのボディの `access_token`（Bearer の方法、RFC 6750 §2.2）を添えたときである。
 *
 * DPoP スキームでなければ（Bearer の提示か、トークンがない）、ほかに何もせずに `dpopAccessToken` と `dpopJkt` が `undefined` の結果を返し、後の Bearer のブロックに任せる。
 * その失敗のエラーの情報は Bearer のチャレンジが伝え、DPoP のチャレンジはエラーなしで並ぶ（RFC 9449 §7.2 Figure 17 / 18）。
 * DPoP スキームなら、トークンを提示したスキームを DPoP にして、このブロックと後のブロックの失敗のエラーの情報を DPoP のチャレンジに入れる（RFC 9449 §7.2）。
 * そのうえで、次を確かめる。
 * - `Authorization` の値がアクセストークンを一つの token68 で持つ（RFC 9449 §7.1）
 * - POST のフォームのボディに空でない `access_token` がない（あれば、上の両方のスキームでトークンを送ったリクエストとして拒否する。RFC 6750 §2）
 * - `DPoP` ヘッダーがちょうど一つある（RFC 9449 §7.1 / §4.3）
 * - DPoP proof が正しい（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はアクセストークンのハッシュ。RFC 9449 §4.3）
 *
 * トークンがその鍵に束縛されていることは、トークンを取得した後のブロック（`verifyDpopUserInfoAccess()`）が確かめる。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @spec RFC 9449 §4.3
 * @spec RFC 6750 §2
 * @throws {UserInfoEndpointError} 401 の `invalid_dpop_proof`: DPoP proof がないか、受け付けないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`: `Authorization: DPoP` にトークンがないか token68 でないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`（どのチャレンジにもエラーの情報を入れる）: Bearer と DPoP の両方でトークンを送ったとき
 * @throws {UserInfoEndpointError} ボディを読めないとき（チャレンジの付かない 400 の `invalid_request`）
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function readDpopUserInfoRequest(request: Request, challenges: UserInfoChallenges): Promise<DpopUserInfoRequest> {
  // DPoP スキームも受け付けることを、Bearer で提示したリクエストやトークンのないリクエストの失敗にも示す（RFC 9449 §7.2 Figure 17 / 18）。
  challenges.offered.push(dpopChallengeOf(dpopSigningAlgsOf(config)));
  const authorization = request.headers.get('Authorization');
  if (namesBearerAndDpopSchemes(authorization)) {
    // どちらのスキームで認証しようとしたのか決まらない（RFC 9449 §7.2 Figure 19）。
    throw ambiguousUserInfoRequestError();
  }
  const credentials = readDpopAuthorization(authorization);
  if (credentials === undefined) return { dpopAccessToken: undefined, dpopJkt: undefined };

  // DPoP スキームで提示したリクエストの失敗は、DPoP のチャレンジがエラーの情報を伝える（RFC 9449 §7.2）。
  challenges.scheme = DPOP_AUTHENTICATION_SCHEME;
  try {
    const accessToken = validateDpopCredentials(credentials);
    if (await formBodyHasAccessToken(request)) {
      // フォームのボディのトークンは Bearer の方法（RFC 6750 §2.2）なので、二つのスキームでトークンを送ったことになる。
      throw ambiguousUserInfoRequestError();
    }
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(request.headers.get('DPoP'));
    if (proof === undefined) {
      throw new DpopError('invalid_dpop_proof', 'A DPoP proof is required with the DPoP authorization scheme');
    }
    const dpopJkt = await verifyDpopRequestProof(proof, { method: request.method, path: '/userinfo', accessToken });
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
 * リクエストのボディは一度しか読めないが、DPoP スキームのリクエストでは Bearer のブロックがボディを読まないので、読むのはこの一回だけである。
 *
 * @spec RFC 6750 §2.2
 * @throws {UserInfoEndpointError} ボディを読めないとき（チャレンジの付かない 400 の `invalid_request`。Bearer のブロックと同じ）
 */
async function formBodyHasAccessToken(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const mediaType = (request.headers.get('Content-Type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mediaType !== 'application/x-www-form-urlencoded') return false;
  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new UserInfoEndpointError({ status: 400, body: { error: 'invalid_request' } });
  }
  return new URLSearchParams(body).getAll('access_token').some((value) => value !== '');
}

/**
 * アクセストークンを束縛した鍵（保存したレコードの `cnf.jkt`）が、トークンの提示の仕方に合うことを確かめる。
 *
 * - DPoP スキームで提示した（`dpopJkt` がある）ときは、トークンがその DPoP proof の鍵に束縛されていなければならない（RFC 9449 §7.1）。
 * - Bearer で提示した（`dpopJkt` が `undefined`）ときは、DPoP の鍵に束縛したトークンを拒否する。束縛したトークンを Bearer として使わせない（RFC 9449 §7.2 の MUST）。
 *
 * 失敗は 401 の `invalid_token` で、エラーの情報は、トークンを提示したスキームのチャレンジ（Bearer で提示したなら Bearer のチャレンジ）が伝える（RFC 9449 §7.2）。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @throws {UserInfoEndpointError} 401 の `invalid_token`: 束縛の鍵と提示の仕方が合わないとき
 */
export function verifyDpopUserInfoAccess(tokenInfo: AccessTokenInfo, dpopJkt: string | undefined): void {
  try {
    validateDpopAccessTokenBinding(readDpopJkt(tokenInfo), dpopJkt);
  } catch (error) {
    throw userInfoEndpointErrorOf(error);
  }
}
