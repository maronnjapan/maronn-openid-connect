/**
 * EXTENSION (dpop): the blocks of userinfo/route.ts (RFC 9449 §7).
 *
 * The UserInfo endpoint calls readDpopUserInfoRequest() in its
 * [read-dpop-access-token] block, before the Bearer token is read, and
 * verifyDpopUserInfoAccess() in its [verify-dpop-access-token] block, once
 * the token is resolved. A failure is a UserInfoEndpointError with the DPoP
 * challenge, which the [respond-error] block answers with as it is.
 */
import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import type { UserInfoChallenge } from '../../../userinfo/response';
import { config } from '../../provider';
import { readDpopJkt } from './binding';
import { dpopSigningAlgsOf } from './config';
import { userInfoEndpointErrorOf } from './error-responses';
import { DpopError } from './errors';
import { readDpopProofHeader, verifyDpopRequestProof } from './proof';
import { readDpopAuthorization, validateDpopAccessTokenBinding } from './resource';

/** What readDpopUserInfoRequest() read: all undefined when the token is not presented with the DPoP scheme. */
export interface DpopUserInfoRequest {
  /** The access token of `Authorization: DPoP <token>`. */
  dpopAccessToken?: string;
  /** The JWK Thumbprint of the key of the verified DPoP proof. */
  dpopJkt?: string;
  /** The DPoP challenge the failures of the later blocks answer with. */
  dpopChallenge?: UserInfoChallenge;
}

/**
 * `Authorization: DPoP` で提示されたアクセストークンを読み、一緒に送られた DPoP proof を検証して、その鍵の JWK Thumbprint を返す。
 *
 * DPoP スキームでなければ（Bearer の提示か、トークンがない）、何もせずにすべて `undefined` の結果を返し、後の Bearer のブロックに任せる。
 * DPoP スキームなら、次を確かめる。
 * - `DPoP` ヘッダーがちょうど一つある（RFC 9449 §7.1 / §4.3）
 * - POST のフォームのボディに `access_token` がない（トークンを送る方法は一つだけ。RFC 6750 §2）
 * - DPoP proof が正しい（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はアクセストークンのハッシュ。RFC 9449 §4.3）
 *
 * 後のブロックの失敗も DPoP のチャレンジで応答するよう、受け付ける alg（`algs`）付きの DPoP のチャレンジを返す（RFC 9449 §7.1）。
 * トークンがその鍵に束縛されていることは、トークンを取得した後のブロック（`verifyDpopUserInfoAccess()`）が確かめる。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §4.3
 * @spec RFC 6750 §2
 * @throws {UserInfoEndpointError} 401 の `invalid_dpop_proof`: DPoP proof がないか、受け付けないとき
 * @throws {UserInfoEndpointError} 400 の `invalid_request`: DPoP スキームにトークンがないとき、二つの方法でトークンを送ったとき
 */
export async function readDpopUserInfoRequest(request: Request): Promise<DpopUserInfoRequest> {
  const algs = dpopSigningAlgsOf(config);
  try {
    const accessToken = readDpopAuthorization(request.headers.get('Authorization'));
    if (accessToken === undefined) return {};
    if (await formBodyHasAccessToken(request)) {
      throw new DpopError('invalid_request', 'Multiple access token methods are not allowed');
    }
    const proof = readDpopProofHeader(request.headers.get('DPoP'));
    if (proof === undefined) {
      throw new DpopError('invalid_dpop_proof', 'A DPoP proof is required with the DPoP authorization scheme');
    }
    const dpopJkt = await verifyDpopRequestProof(proof, { method: request.method, path: '/userinfo', accessToken });
    return { dpopAccessToken: accessToken, dpopJkt, dpopChallenge: { scheme: 'DPoP', parameters: `algs="${algs.join(' ')}"` } };
  } catch (error) {
    throw userInfoEndpointErrorOf(error, algs);
  }
}

/**
 * POST のフォームのボディが `access_token` パラメータを持つかを返す。
 *
 * メディアタイプが `application/x-www-form-urlencoded` の POST だけを読む。
 * リクエストのボディは一度しか読めないが、DPoP スキームのリクエストでは Bearer のブロックがボディを読まないので、読むのはこの一回だけである。
 *
 * @spec RFC 6750 §2.2
 */
async function formBodyHasAccessToken(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const mediaType = (request.headers.get('Content-Type') ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mediaType !== 'application/x-www-form-urlencoded') return false;
  return new URLSearchParams(await request.text()).has('access_token');
}

/**
 * アクセストークンを束縛した鍵（保存したレコードの `cnf.jkt`）が、トークンの提示の仕方に合うことを確かめる。
 *
 * - DPoP スキームで提示した（`dpopJkt` がある）ときは、トークンがその DPoP proof の鍵に束縛されていなければならない（RFC 9449 §7.1）。
 * - Bearer で提示した（`dpopJkt` が `undefined`）ときは、DPoP の鍵に束縛したトークンを拒否する。束縛したトークンを Bearer として使わせない（RFC 9449 §7.2 の MUST）。
 *
 * 失敗は 401 の `invalid_token` で、受け付ける alg 付きの DPoP のチャレンジで応答する。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @throws {UserInfoEndpointError} 401 の `invalid_token`: 束縛の鍵と提示の仕方が合わないとき
 */
export function verifyDpopUserInfoAccess(tokenInfo: AccessTokenInfo, dpopJkt: string | undefined): void {
  try {
    validateDpopAccessTokenBinding(readDpopJkt(tokenInfo), dpopJkt);
  } catch (error) {
    throw userInfoEndpointErrorOf(error, dpopSigningAlgsOf(config));
  }
}
