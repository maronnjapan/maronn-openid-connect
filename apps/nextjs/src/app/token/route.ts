/**
 * Token Endpoint (OIDC Core 1.0 §3.1.3).
 *
 * Authenticates the client, validates the grant it presents and answers with
 * the token response: authorization_code here, and refresh_token in the
 * (feature: refresh-token) blocks.
 *
 * The grants of the other features (token exchange, ID-JAG, device_code, CIBA)
 * are answered in their own blocks right after client authentication and
 * before validateGrantTypeSupported, each by the grant.ts of its feature.
 */
import {
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
  generateIdToken,
  hasRequestedIdTokenClaims,
  selectRequestedIdTokenClaims,
  buildAccessTokenAudience,
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  TokenError,
  TokenErrorCode,
  type AuthorizationCodeData,
  type TokenRequestParams,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { dispatchCiba } from '../_oidc-provider/features/ciba/grant';
import { dispatchDeviceCode } from '../_oidc-provider/features/device-authorization-grant/grant';
import { dispatchIdJagIssuance, dispatchIdJagRedemption } from '../_oidc-provider/features/id-jag/grant';
import {
  decideRefreshTokenIssuance,
  issueRefreshToken,
  revokeRotatedRefreshToken,
  validateRefreshTokenGrant,
} from '../_oidc-provider/features/refresh-token/token';
import { dispatchTokenExchange } from '../_oidc-provider/features/token-exchange/grant';
import { tokenGrantsOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  accessTokenIssuer,
  acrResolver,
  clientResolver,
  config,
  loadSigningKeys,
  resolvers,
  selectIdTokenSigningKey,
  stores,
} from '../_oidc-provider/provider';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  signingKeysUnavailable,
  uniqueParams,
  withCors,
} from '../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const { authorizationCodeResolver } = resolvers;
const { authCodeStore, accessTokenStore } = stores;

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await token(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function token(request: Request): Promise<Response> {
  // [load-signing-keys] Load the signing keys — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [parse-request] Parse the token request — RFC 6749 §4.1.3 / §3.2
  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: the Token Request body MUST be
  // application/x-www-form-urlencoded; anything else is rejected unparsed.
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Token requests must use application/x-www-form-urlencoded');
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  const { params: rawParams, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', `Parameter "${duplicateKey}" must not be repeated`);
  }
  if (!isTokenRequestParams(rawParams)) {
    return oauthError('invalid_request', 'Missing required parameter: grant_type');
  }
  const params = rawParams;

  try {
    // [authenticate-client] Authenticate the client — OAuth 2.1 §2.3 / OIDC Core 1.0 §9
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
    // Each step below is an independent core function. Replace
    // verifyClientSecret with your own assertion check (e.g. private_key_jwt)
    // without touching the rest.

    // Read the presented credentials and which method was actually used.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });

    // RFC 6749 §5.2: the presented client_id must resolve to a registered client.
    const tokenClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );

    // OIDC Core 1.0 §9: the method used must be one the client registered
    // (blocks auth method downgrade / public-client mixups).
    validateClientAuthMethod(tokenClient, presentedCredentials);

    // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
    await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

    const authenticatedClientId = presentedCredentials.clientId;

    // [dispatch-id-jag-issuance] (feature: id-jag) Issue an ID-JAG (Cross-App Access) — ID-JAG draft §4.3
    const idJagIssuance = await dispatchIdJagIssuance(params, tokenClient, keys);
    if (idJagIssuance) return idJagIssuance;

    // [dispatch-id-jag-redemption] (feature: id-jag) Redeem an ID-JAG on the jwt-bearer grant — ID-JAG draft §4.4 / RFC 7523 §2.1
    const idJagRedemption = await dispatchIdJagRedemption(params, tokenClient, keys);
    if (idJagRedemption) return idJagRedemption;

    // [dispatch-token-exchange] (feature: token-exchange) Token Exchange — RFC 8693 §2.1
    const exchanged = await dispatchTokenExchange(params, tokenClient, keys);
    if (exchanged) return exchanged;

    // [dispatch-device-code] (feature: device-authorization-grant) Redeem a device_code — RFC 8628 §3.4 / §3.5
    const deviceGrantResponse = await dispatchDeviceCode(params, tokenClient, keys);
    if (deviceGrantResponse) return deviceGrantResponse;

    // [dispatch-ciba] (feature: ciba) Redeem an auth_req_id (CIBA) — CIBA Core 1.0 §10.1 / §11
    const cibaGrantResponse = await dispatchCiba(params, tokenClient, keys);
    if (cibaGrantResponse) return cibaGrantResponse;

    // [validate-grant-type] Validate grant_type — RFC 6749 §5.2
    // Is the grant_type offered by this OP at all? authorization_code always;
    // refresh_token when the refresh-token feature answers it (the token entry
    // of its feature.ts). The grants a feature answers itself were dispatched
    // above.
    const grantType = validateGrantTypeSupported(params.grant_type, [
      'authorization_code',
      ...tokenGrantsOf(features),
    ]);
    // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
    validateClientGrantType(tokenClient, grantType);

    // [validate-refresh-token-grant] (feature: refresh-token) Validate the refresh_token grant — OAuth 2.1 §4.3.1 / RFC 6749 §6
    const refreshTokenRequest = await validateRefreshTokenGrant(params, authenticatedClientId, grantType);

    // [validate-authorization-code-grant] Validate the authorization_code grant — OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2
    const validatedRequest =
      refreshTokenRequest ?? (await validateAuthorizationCodeGrant(params, authenticatedClientId));

    // [select-signing-keys] Select the signing keys — OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)
    // T-022: the ID Token is signed with the registered ID Token key whose alg
    // matches the client's id_token_signed_response_alg (RS256 by default).
    const idTokenAlg = (tokenClient as RegisteredClient).idTokenSignedResponseAlg;
    const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
    if (!idTokenKey) {
      return oauthError(
        'server_error',
        `No ID Token signing key registered for alg "${idTokenAlg ?? 'RS256'}"`,
        500,
      );
    }

    // [resolve-subject] Resolve the subject, auth_time and nonce — OIDC Core 1.0 §12.2
    let subject: string;
    let authTime: number | undefined;
    let nonce: string | undefined;

    if (validatedRequest.grantType === 'authorization_code') {
      // The store holds what the consent step stored: createAuthorizationCode()'s
      // record, which also carries the authenticated subject and auth_time.
      const authCode = (await authCodeStore.get(validatedRequest.code)) as
        | AuthorizationCodeData
        | undefined;
      if (!authCode?.subject || !authCode.authTime) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'Authorization code missing required subject context',
        );
      }
      subject = authCode.subject;
      authTime = authCode.authTime;
      nonce = validatedRequest.nonce;
    } else {
      // refresh_token grant.
      // OIDC Core 1.0 §12.2: the re-issued ID Token retains iss/sub/aud/exp/iat/
      // auth_time/azp/acr/amr — nonce is NOT in that list. nonce binds an
      // Authentication Request to its ID Token (§2); a refresh has no such
      // request, so carrying the old nonce adds no replay protection. Major OPs
      // (Google, Auth0) omit it on refresh, and so does this one. auth_time is
      // still preserved per §12.1.
      subject = validatedRequest.subject;
      authTime = validatedRequest.authTime;
      nonce = undefined;
    }

    // アクセストークンの audience を決定する（合成ポリシーは core の buildAccessTokenAudience に集約）。
    // RFC 9068 §3: JWT access token の aud は非空でなければならない。
    // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使用できるため、UserInfo
    // エンドポイント（discovery が広告する userinfo_endpoint と同じ URL）を aud の恒久メンバとして
    // 必ず含める。resource 指定（validatedRequest.audience）があれば末尾に追加し、UserInfo
    // エンドポイントを取り除くことはしない。重複は除去される。
    // refresh では保存済み aud（既に UserInfo を含む）を引き継ぐため、再計算しても同一集合になる。
    const effectiveAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${config.issuer}/userinfo`,
      requested: validatedRequest.audience,
      issuer: config.issuer,
    });

    // [decide-refresh-token-issuance] (feature: refresh-token) Decide whether a refresh token is issued — OIDC Core 1.0 §11 / RFC 9700 §4.14
    const refreshTokenDecision = decideRefreshTokenIssuance(tokenClient, validatedRequest);

    // [resolve-acr-amr] Resolve the acr / amr the tokens carry — OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1
    // Each step below is an independent core function. Add your own ID Token
    // claims by editing idTokenPayload before it is signed.
    // T-015: acr / amr of the tokens. The ID Token carries both, and the access
    // token the acr, so a resource server can tell how the End-User
    // authenticated (RFC 9068 §2.2.1).
    // - authorization_code: ask acrResolver (provider.ts); acr_values and the
    //   claims request are forwarded so it can honor them.
    // - refresh_token: the stored acr / amr are reused so OIDC Core 1.0 §12.1
    //   "preserve initial auth context" holds; the resolver is bypassed.
    const { acr, amr } = await resolveAcrAmr({
      subject,
      clientId: validatedRequest.clientId,
      acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : undefined,
      amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : undefined,
      acrResolver: validatedRequest.grantType === 'authorization_code' ? acrResolver : undefined,
      requestedAcrValues:
        validatedRequest.grantType === 'authorization_code' ? validatedRequest.acrValues : undefined,
      // OIDC Core 1.0 §5.5: the parsed claims request lets the resolver satisfy
      // id_token member requests (e.g. acr.values).
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    });

    // [issue-access-token] Issue the access token — RFC 9068 §2.2 / §2.2.1 / §3
    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);

    // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id, and the
    // acr of the authentication (§2.2.1) when there is one.
    // Add access token claims here before the payload is signed.
    const accessTokenPayload = buildAccessTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      audience: effectiveAudience,
      expiresIn: config.accessTokenExpiresIn,
      issuedAt,
      acr,
    });

    // JWT or opaque, as chosen by config.accessTokenFormat (provider.ts).
    const accessToken = await accessTokenIssuer.issue({
      payload: accessTokenPayload,
      privateKey: keys.general[0].privateKey,
      keyId: keys.general[0].keyId,
    });

    // [issue-id-token] Issue the ID Token — OIDC Core 1.0 §3.1.3.6 / §5.5 / §12.1
    // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
    // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
    // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
    let idToken: string | undefined;
    if (validatedRequest.scope.includes('openid')) {
      // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
      // The hash function follows the ID Token signing alg.
      const atHash = await computeAtHash(accessToken, idTokenKey.privateKey);

      // OIDC Core 1.0 §5.5: the claims the id_token member of the claims
      // parameter of the authorization request asks for, whatever the scope
      // (the claims of the scope values stay with the UserInfo endpoint, §5.4).
      // A refresh carries no claims request.
      const claims = validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined;
      const userClaims = hasRequestedIdTokenClaims(claims)
        ? (await resolvers.userClaimsResolver.findUserClaims(subject)) ?? undefined
        : undefined;

      const idTokenPayload = buildIdTokenPayload({
        issuer: config.issuer,
        subject,
        clientId: validatedRequest.clientId,
        scope: validatedRequest.scope,
        expiresIn: config.idTokenExpiresIn,
        issuedAt,
        atHash,
        nonce,
        authTime,
        acr,
        amr,
        requestedClaims: userClaims === undefined ? undefined : selectRequestedIdTokenClaims(userClaims, claims),
      });

      // Add your own ID Token claims here, e.g.:
      //   idTokenPayload.tenant_id = await lookupTenant(subject);

      idToken = await generateIdToken({
        payload: idTokenPayload,
        privateKey: idTokenKey.privateKey,
        keyId: idTokenKey.keyId,
      });
    }

    // [persist-access-token] Store the access token record — RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2
    // Store the access token for the UserInfo / Introspection / Revocation
    // endpoints. iat / nbf / audience / issuer / acr are kept so introspection
    // can echo them; grantId ties the token to its authorization grant so it is
    // revoked with its siblings on code reuse (OAuth 2.1 §4.1.2).
    await accessTokenStore.set(accessToken, {
      sub: subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      expiresAt: issuedAt + config.accessTokenExpiresIn,
      grantId: validatedRequest.grantId,
      iat: issuedAt,
      // RFC 7519 §4.1.5 / RFC 7662 §2.2: persist nbf (= iat) for JWT and opaque
      // tokens alike so introspection reports a not-yet-valid token inactive.
      nbf: issuedAt,
      audience: effectiveAudience,
      issuer: config.issuer,
      // RFC 9068 §2.2 / RFC 7662 §2.2: the token identifier core minted for this
      // issuance. It also keeps two same-second issuances distinct (RS256 is
      // deterministic), so this store key never collides across grants.
      jti: accessTokenPayload.jti,
      // OIDC Core 1.0 §5.5: the authorization request's claims parameter, so the
      // UserInfo endpoint can honor claims.userinfo members independently of scope.
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
      // RFC 9068 §2.2.1 / RFC 9470 §6.2: the acr the token was issued with, so
      // introspection reports it for an opaque token too.
      acr,
    });

    // [issue-refresh-token] (feature: refresh-token) Mint and store the refresh token — OAuth 2.1 §4.3.1 / §6.1
    const refreshToken = await issueRefreshToken({
      decision: refreshTokenDecision,
      subject,
      authTime,
      nonce,
      validatedRequest,
      issuedAt,
      audience: effectiveAudience,
      acr,
      amr,
    });

    // [revoke-rotated-refresh-token] (feature: refresh-token) Revoke the presented refresh token (rotation) — OAuth 2.1 §4.3.1
    await revokeRotatedRefreshToken(params, validatedRequest);

    // [build-token-response] Build the token response body — OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1
    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: refreshToken,
    };

    // [respond] Respond (no-store) — RFC 6749 §5.1
    return noStoreJson(tokenResponse);
  } catch (error) {
    // [respond-error] Answer the token error — RFC 6749 §5.2 / RFC 6750 §3
    if (error instanceof TokenError) {
      // RFC 6750 §3 / OAuth 2.1 §5.2: a 401 carries WWW-Authenticate.
      return oauthError(
        error.error,
        error.errorDescription,
        error.statusCode,
        error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
      );
    }
    return oauthError('server_error', undefined, 500);
  }
}

/** Narrows raw body params to TokenRequestParams: grant_type is required. */
function isTokenRequestParams(params: unknown): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  return typeof (params as Record<string, unknown>)['grant_type'] === 'string';
}

/**
 * Validate the authorization_code grant (OAuth 2.1 §4.1.2 / RFC 7636 / OIDC
 * Core 1.0 §3.1.3.2). Each security rule is a separate core call so it can be
 * removed, replaced, or surrounded with experiment-specific logic.
 */
async function validateAuthorizationCodeGrant(
  params: TokenRequestParams,
  authenticatedClientId: string,
): Promise<ValidatedTokenRequest> {
  // Resolve the presented authorization code and retain the non-optional code.
  const { code, authorizationCode } = await resolveAuthorizationCode(params, authorizationCodeResolver);

  // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
  await validateAuthorizationCodeUnused(authorizationCode, authorizationCodeResolver);

  // Bind the authorization code to the authenticated client and its lifetime.
  validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
  validateAuthorizationCodeExpiration(authorizationCode);

  // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
  validateAuthorizationCodeRedirectUri(authorizationCode, params.redirect_uri);

  // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
  const codeVerified = await verifyAuthorizationCodePkce(authorizationCode, params.code_verifier);

  // Mark used (do not physically delete) so a later replay remains detectable.
  await consumeAuthorizationCode(code, authorizationCodeResolver);

  return buildValidatedAuthorizationCodeRequest(code, authorizationCode, authenticatedClientId, codeVerified);
}
