import { Hono } from 'hono';
import { readDpopUserInfoRequest } from '../../features/dpop/steps/read-dpop-access-token.js';
import { verifyDpopUserInfoAccess } from '../../features/dpop/steps/verify-dpop-access-token.js';
import { BEARER_CHALLENGE, type UserInfoChallenges } from './response.js';
import { buildUserInfoResponse } from './steps/build-response.js';
import { parseUserInfoRequest } from './steps/parse-access-token.js';
import { resolveUserInfoToken } from './steps/resolve-access-token.js';
import { resolveUserInfoResponseClaims } from './steps/resolve-claims.js';
import { respondUserInfoError } from './steps/respond-error.js';
import { respondUserInfo } from './steps/respond.js';

/**
 * UserInfo endpoint (API layer).
 * OIDC Core 1.0 Section 5.3
 *
 * Each block below calls one step of the endpoint (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint userinfo`: read the Bearer
 * token, resolve and validate it, resolve the claims it may see, build the
 * response (JSON, or a signed JWT when the client registered
 * userinfo_signed_response_alg) and answer. A step that throws ends in
 * respondUserInfoError(), with the challenges of the schemes the endpoint
 * accepts.
 *
 * With the dpop extension, the (feature: dpop) block before the Bearer token
 * adds the DPoP challenge beside the Bearer one, rejects a token sent with
 * both schemes, and reads a token presented with the DPoP scheme and checks
 * its DPoP proof; the one after the token is resolved checks that the key the
 * token is bound to matches how it was presented (RFC 9449 §7.1 / §7.2). With
 * dpopNonceRequiredAtResourceServer, the first block gives every response
 * from then on to a request presented with the DPoP scheme a new nonce of the
 * protected resource (DPoP-Nonce) and rejects a proof without a nonce it
 * recently provided (use_dpop_nonce, RFC 9449 §9).
 */
export const userinfoApp = new Hono<{ Variables: Record<string, any> }>();

/** アクセストークンを検証し、開示できる UserInfo を JSON か署名付き JWT で返す。 */
async function handler(c: any): Promise<Response> {
  // 失敗の応答に並べるチャレンジ（`WWW-Authenticate`）。受け付ける認証スキームごとに一つで、機能を有効にしなければ Bearer だけである（RFC 6750 §3）。
  // 自分のスキームを受け付ける機能のブロックは、そのチャレンジを足し、リクエストがそのスキームでトークンを提示したら `scheme` を書き換える（RFC 9449 §7.2）。
  // どのステップが失敗しても `catch` で読めるよう、`try` の前で宣言する。
  const challenges: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: BEARER_CHALLENGE.scheme };
  try {
    // [read-dpop-access-token] (feature: dpop) DPoP のチャレンジを並べ、DPoP スキームのアクセストークンを読んで DPoP proof を検証する — RFC 9449 §7.1 / §7.2 / §4.3 / §9
    const { dpopAccessToken, dpopJkt } = await readDpopUserInfoRequest(c, challenges);

    // [parse-access-token] Bearer トークンを読み取る — RFC 6750 §2.1 / §2.2
    // 機能のブロックが別のスキームのトークンを読んだ（`dpopAccessToken`）ときは、そのトークンを使う。
    const accessToken = dpopAccessToken ?? (await parseUserInfoRequest(c));

    // [resolve-access-token] アクセストークンを取得して検証する — OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4
    const tokenInfo = await resolveUserInfoToken(c, accessToken);

    // [verify-dpop-access-token] (feature: dpop) トークンを束縛した鍵と提示の仕方を照らし合わせる — RFC 9449 §7.1 / §7.2
    verifyDpopUserInfoAccess(tokenInfo, dpopJkt);

    // [resolve-claims] トークンで開示できるクレームを決める — OIDC Core 1.0 §5.4 / §5.5
    const claims = await resolveUserInfoResponseClaims(c, tokenInfo);

    // [build-response] レスポンスを組み立てる（JSON か署名付き JWT） — OIDC Core 1.0 §5.3.2
    const userInfoResponse = await buildUserInfoResponse(c, tokenInfo, claims);

    // [respond] 応答する（no-store） — RFC 6750 §5.2
    return respondUserInfo(c, userInfoResponse);
  } catch (error) {
    return respondUserInfoError(c, error, challenges);
  }
}

userinfoApp.get('/', handler);
userinfoApp.post('/', handler);
