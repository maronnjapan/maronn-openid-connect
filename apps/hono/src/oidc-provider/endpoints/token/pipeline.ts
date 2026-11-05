import { Hono } from 'hono';
import { redeemCibaRequest } from '../../features/ciba/steps/dispatch-ciba.js';
import { redeemDeviceCode } from '../../features/device-authorization-grant/steps/dispatch-device-code.js';
import { issueIdJag } from '../../features/id-jag/steps/dispatch-id-jag-issuance.js';
import { redeemIdJag } from '../../features/id-jag/steps/dispatch-id-jag-redemption.js';
import { decideRefreshTokenIssuance } from '../../features/refresh-token/steps/decide-refresh-token-issuance.js';
import { issueRefreshToken } from '../../features/refresh-token/steps/issue-refresh-token.js';
import { revokeRotatedRefreshToken } from '../../features/refresh-token/steps/revoke-rotated-refresh-token.js';
import { validateRefreshTokenGrant } from '../../features/refresh-token/steps/validate-refresh-token-grant.js';
import { exchangeToken } from '../../features/token-exchange/steps/dispatch-token-exchange.js';
import { authenticateTokenClient } from './steps/authenticate-client.js';
import { buildTokenResponse } from './steps/build-token-response.js';
import { issueAccessToken } from './steps/issue-access-token.js';
import { issueIdToken } from './steps/issue-id-token.js';
import { parseTokenRequest } from './steps/parse-request.js';
import { persistAccessToken } from './steps/persist-access-token.js';
import { resolveTokenAcrAmr } from './steps/resolve-acr-amr.js';
import { resolveTokenSubject } from './steps/resolve-subject.js';
import { respondTokenError } from './steps/respond-error.js';
import { respondToken } from './steps/respond.js';
import { selectTokenSigningKeys } from './steps/select-signing-keys.js';
import { validateAuthorizationCodeGrant } from './steps/validate-authorization-code-grant.js';
import { validateTokenGrantType } from './steps/validate-grant-type.js';

/**
 * Token endpoint (API layer).
 * OIDC Core 1.0 Section 3.1.3 / RFC 6749 Section 4.1.3
 *
 * Each block below calls one step (one box of
 * `maronn-oidc graph --detail steps --endpoint token`): parse the request,
 * authenticate the client, dispatch the grants a feature answers, validate
 * the grant, select the keys, resolve the subject, issue and store the
 * tokens, and answer. Delete a block to drop that step, or insert your own
 * logic between two blocks. A block whose marker names a feature belongs to
 * that feature, and its step is in features/<id>/. A step that throws ends in
 * respondTokenError().
 */
export const tokenApp = new Hono<{ Variables: Record<string, any> }>();

tokenApp.post('/', async (c) => {
  try {
    // [parse-request] トークンリクエストを解析する — RFC 6749 §4.1.3 / §3.2
    const { params, authorization } = await parseTokenRequest(c);

    // [authenticate-client] クライアントを認証する — OAuth 2.1 §2.3 / OIDC Core 1.0 §9
    const { tokenClient, authenticatedClientId } = await authenticateTokenClient(c, params, authorization);

    // [dispatch-id-jag-issuance] (feature: id-jag) ID-JAG を発行する（Cross-App Access） — ID-JAG draft §4.3
    const idJagIssuance = await issueIdJag(c, params, tokenClient);
    if (idJagIssuance) return idJagIssuance;

    // [dispatch-id-jag-redemption] (feature: id-jag) jwt-bearer グラントで ID-JAG を引き換える — ID-JAG draft §4.4 / RFC 7523 §2.1
    const idJagRedemption = await redeemIdJag(c, params, tokenClient);
    if (idJagRedemption) return idJagRedemption;

    // [dispatch-token-exchange] (feature: token-exchange) トークン交換 — RFC 8693 §2.1
    const exchanged = await exchangeToken(c, params, tokenClient);
    if (exchanged) return exchanged;

    // [dispatch-device-code] (feature: device-authorization-grant) device_code を引き換える — RFC 8628 §3.4 / §3.5
    const deviceGrantResponse = await redeemDeviceCode(c, params, tokenClient, authenticatedClientId);
    if (deviceGrantResponse) return deviceGrantResponse;

    // [dispatch-ciba] (feature: ciba) auth_req_id を引き換える（CIBA） — CIBA Core 1.0 §10.1 / §11
    const cibaGrantResponse = await redeemCibaRequest(c, params, tokenClient, authenticatedClientId);
    if (cibaGrantResponse) return cibaGrantResponse;

    // [validate-grant-type] grant_type を検証する — RFC 6749 §5.2
    const grantType = validateTokenGrantType(params, tokenClient);

    // [validate-refresh-token-grant] (feature: refresh-token) refresh_token グラントを検証する — OAuth 2.1 §4.3.1 / RFC 6749 §6
    const refreshTokenRequest = await validateRefreshTokenGrant(c, params, authenticatedClientId, grantType);

    // [validate-authorization-code-grant] authorization_code グラントを検証する — OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2
    const validatedRequest =
      refreshTokenRequest ?? (await validateAuthorizationCodeGrant(c, params, authenticatedClientId));

    // [select-signing-keys] 署名鍵を選ぶ — OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)
    const { signingKey, idTokenSigningKey } = await selectTokenSigningKeys(c, authenticatedClientId);

    // [resolve-subject] サブジェクト、auth_time、nonce を取り出す — OIDC Core 1.0 §12.2
    const { subject, authTime, nonce } = await resolveTokenSubject(c, validatedRequest);

    // [decide-refresh-token-issuance] (feature: refresh-token) リフレッシュトークンを発行するか決める — OIDC Core 1.0 §11 / RFC 9700 §4.14
    const refreshTokenDecision = decideRefreshTokenIssuance(c, tokenClient, validatedRequest);

    // [resolve-acr-amr] トークンに含める acr と amr を決める — OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1
    const { acr, amr } = await resolveTokenAcrAmr(c, { subject, validatedRequest });

    // [issue-access-token] アクセストークンを発行する — RFC 9068 §2.2 / §2.2.1 / §3
    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);
    const { accessToken, accessTokenPayload, audience } = await issueAccessToken(c, { signingKey, subject, validatedRequest, issuedAt, acr });

    // [issue-id-token] ID トークンを発行する — OIDC Core 1.0 §3.1.3.6 / §12.1
    const idToken = await issueIdToken(c, { idTokenSigningKey, accessToken, subject, authTime, nonce, validatedRequest, issuedAt, acr, amr });

    // [persist-access-token] アクセストークンのレコードを保存する — RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2
    await persistAccessToken(c, { accessToken, accessTokenPayload, subject, validatedRequest, issuedAt, audience, acr });

    // [issue-refresh-token] (feature: refresh-token) リフレッシュトークンを発行して保存する — OAuth 2.1 §4.3.1 / §6.1
    const refreshToken = await issueRefreshToken(c, {
      decision: refreshTokenDecision,
      subject,
      authTime,
      nonce,
      validatedRequest,
      issuedAt,
      audience,
      acr,
      amr,
    });

    // [revoke-rotated-refresh-token] (feature: refresh-token) 古いリフレッシュトークンを失効させる — OAuth 2.1 §4.3.1
    await revokeRotatedRefreshToken(c, params, validatedRequest);

    // [build-token-response] トークンレスポンスのボディを組み立てる — OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1
    const tokenResponse = buildTokenResponse(c, { accessToken, idToken, refreshToken, validatedRequest });

    // [respond] 応答する（no-store） — RFC 6749 §5.1
    return respondToken(c, tokenResponse);
  } catch (error) {
    return respondTokenError(c, error);
  }
});
