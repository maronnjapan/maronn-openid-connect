import { Hono } from 'hono';
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
 * respondUserInfoError().
 */
export const userinfoApp = new Hono<{ Variables: Record<string, any> }>();

/** アクセストークンを検証し、開示できる UserInfo を JSON か署名付き JWT で返す。 */
async function handler(c: any): Promise<Response> {
  try {
    // [parse-access-token] Bearer トークンを読み取る — RFC 6750 §2.1 / §2.2
    const accessToken = await parseUserInfoRequest(c);

    // [resolve-access-token] アクセストークンを取得して検証する — OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4
    const tokenInfo = await resolveUserInfoToken(c, accessToken);

    // [resolve-claims] トークンで開示できるクレームを決める — OIDC Core 1.0 §5.4 / §5.5
    const claims = await resolveUserInfoResponseClaims(c, tokenInfo);

    // [build-response] レスポンスを組み立てる（JSON か署名付き JWT） — OIDC Core 1.0 §5.3.2
    const userInfoResponse = await buildUserInfoResponse(c, tokenInfo, claims);

    // [respond] 応答する（no-store） — RFC 6750 §5.2
    return respondUserInfo(c, userInfoResponse);
  } catch (error) {
    return respondUserInfoError(c, error);
  }
}

userinfoApp.get('/', handler);
userinfoApp.post('/', handler);
