/**
 * Next.js templates for the Token Endpoint: `token/route.ts` and the modules
 * next to it that answer the experimental grants.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE } from '../hono/templates.js';

const EXPERIMENTAL_NOTICE = ` * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version.`;

/** `token/route.ts` — OIDC Core 1.0 §3.1.3. */
export function nextJsTokenRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const refresh = features.refreshToken;
  const experimentalGrants = [
    ...(features.tokenExchange ? ['token exchange (token-exchange.ts)'] : []),
    ...(features.idJag ? ['ID-JAG issuance and redemption (id-jag.ts)'] : []),
    ...(features.deviceAuthorizationGrant ? ['device_code (device-code.ts)'] : []),
    ...(features.ciba ? ['CIBA (ciba.ts)'] : []),
  ];
  const experimentalGrantDoc = experimentalGrants.length > 0
    ? `
 *
 * The experimental grants live in the modules next to this file, each
 * dispatched right after client authentication and before core's
 * validateGrantTypeSupported (which does not know their URNs):
${experimentalGrants.map((grant) => ` * - ${grant}`).join('\n')}`
    : '';

  const coreImports = [
    'validateGrantTypeSupported',
    'resolveAuthenticatedTokenClient',
    'validateClientGrantType',
    'resolveAuthorizationCode',
    'validateAuthorizationCodeUnused',
    'validateAuthorizationCodeClient',
    'validateAuthorizationCodeExpiration',
    'validateAuthorizationCodeRedirectUri',
    'verifyAuthorizationCodePkce',
    'consumeAuthorizationCode',
    'buildValidatedAuthorizationCodeRequest',
    ...(refresh
      ? [
        'resolveRefreshToken',
        'validateRefreshTokenUnused',
        'validateRefreshTokenClient',
        'validateRefreshTokenExpiration',
        'validateRefreshTokenIdleTimeout',
        'validateRefreshTokenScope',
        'validateRefreshTokenSession',
        'clientAllowsRefreshTokenGrant',
        'buildValidatedRefreshTokenRequest',
      ]
      : []),
    'buildAccessTokenPayload',
    'computeAtHash',
    'resolveAcrAmr',
    'buildIdTokenPayload',
    'generateIdToken',
    ...(refresh ? ['generateRandomString'] : []),
    'buildAccessTokenAudience',
    'extractClientCredentials',
    'validateClientAuthMethod',
    'verifyClientSecret',
    'TokenError',
    'TokenErrorCode',
    'type AuthorizationCodeData',
    'type TokenRequestParams',
    'type ValidatedTokenRequest',
  ];

  // Each experimental grant contributes its URN constant and its error class
  // (mapped below), plus the handler from its module.
  const experimentalImports = [
    ...(features.tokenExchange
      ? [`import { TOKEN_EXCHANGE_GRANT_TYPE, TokenExchangeError } from '${EXPERIMENTAL_PACKAGE}/token-exchange';`]
      : []),
    ...(features.idJag
      ? [`import {
  IdJagError,
  JWT_BEARER_GRANT_TYPE,${features.tokenExchange ? '' : '\n  ID_JAG_TOKEN_TYPE,\n  TOKEN_EXCHANGE_GRANT_TYPE,'}
  matchesIdJagIssuanceRequest,
} from '${EXPERIMENTAL_PACKAGE}/id-jag';`]
      : []),
    ...(features.deviceAuthorizationGrant
      ? [`import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceAuthorizationError,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';`]
      : []),
    ...(features.ciba
      ? [`import { CIBA_GRANT_TYPE, CibaGrantError } from '${EXPERIMENTAL_PACKAGE}/ciba';`]
      : []),
  ];
  const grantModuleImports = [
    ...(features.tokenExchange ? [`import { exchangeToken } from './token-exchange';`] : []),
    ...(features.idJag ? [`import { issueIdJag, redeemIdJag } from './id-jag';`] : []),
    ...(features.deviceAuthorizationGrant ? [`import { redeemDeviceCode } from './device-code';`] : []),
    ...(features.ciba ? [`import { redeemCibaRequest } from './ciba';`] : []),
  ];
  const importBlock = [...experimentalImports, ...grantModuleImports];
  const experimentalImportBlock = importBlock.length > 0 ? `\n${importBlock.join('\n')}` : '';

  const experimentalDispatch = [
    ...(features.idJag
      ? [`    // EXPERIMENTAL — ID-JAG issuance (Cross-App Access, draft §4.3): a token
    // exchange whose requested_token_type is the ID-JAG URN. Checked BEFORE the
    // plain token exchange, which shares the grant_type URN.
    if (matchesIdJagIssuanceRequest(params)) {
      return await issueIdJag(params, tokenClient, keys);
    }
${features.tokenExchange ? '' : `
    // Generated without --enable token-exchange: the exchange grant exists only to
    // issue ID-JAGs, so any other requested_token_type is answered with a pointer
    // instead of falling through to unsupported_grant_type (discovery does
    // advertise the exchange grant in this build).
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
      return oauthError(
        'invalid_request',
        \`This authorization server only supports requested_token_type \${ID_JAG_TOKEN_TYPE} for token exchange\`,
      );
    }
`}
    // EXPERIMENTAL — ID-JAG redemption on the jwt-bearer grant (draft §4.4).
    if (params.grant_type === JWT_BEARER_GRANT_TYPE) {
      return await redeemIdJag(params, tokenClient, keys);
    }
`]
      : []),
    ...(features.tokenExchange
      ? [`    // EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
      return await exchangeToken(params, tokenClient, keys);
    }
`]
      : []),
    ...(features.deviceAuthorizationGrant
      ? [`    // EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628 §3.4).
    if (params.grant_type === DEVICE_CODE_GRANT_TYPE) {
      return await redeemDeviceCode(params, tokenClient, keys);
    }
`]
      : []),
    ...(features.ciba
      ? [`    // EXPERIMENTAL — CIBA grant (CIBA Core 1.0 §10.1, poll mode).
    if (params.grant_type === CIBA_GRANT_TYPE) {
      return await redeemCibaRequest(params, tokenClient, keys);
    }
`]
      : []),
  ];
  const experimentalDispatchBlock = experimentalDispatch.length > 0
    ? `\n${experimentalDispatch.join('\n')}`
    : '';
  const experimentalErrorClasses = [
    ...(features.idJag ? ['IdJagError'] : []),
    ...(features.tokenExchange ? ['TokenExchangeError'] : []),
    ...(features.deviceAuthorizationGrant ? ['DeviceAuthorizationError'] : []),
    ...(features.ciba ? ['CibaGrantError'] : []),
  ];
  const experimentalErrorMapping = experimentalErrorClasses.length > 0
    ? `    if (
${experimentalErrorClasses.map((name) => `      error instanceof ${name}`).join(' ||\n')}
    ) {
      // The experimental grants answer in the RFC 6749 §5.2 shape and always with
      // 400: a 401 can only come from client authentication, which runs before
      // them and throws core's TokenError.
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
`
    : '';

  const resolverNames = [
    'authorizationCodeResolver',
    ...(refresh ? ['refreshTokenResolver', 'authenticationSessionResolver'] : []),
  ];
  const storeNames = ['authCodeStore', 'accessTokenStore', ...(refresh ? ['refreshTokenStore'] : [])];

  const grantTypeSupportedStep = refresh
    ? `    // RFC 6749 §5.2: is the grant_type offered by this OP at all?
    // (defaults to ['authorization_code', 'refresh_token'])
    const grantType = validateGrantTypeSupported(params.grant_type);
`
    : `    // The refresh_token feature is disabled: the OP only offers the
    // authorization_code grant, so refresh_token requests are rejected with
    // unsupported_grant_type (RFC 6749 §5.2).
    const grantType = validateGrantTypeSupported(params.grant_type, ['authorization_code']);
`;
  const grantValidationStep = refresh
    ? `    // Grant-specific validation. Each security rule is a separate core call so
    // it can be removed, replaced, or surrounded with experiment-specific logic.
    let validatedRequest: ValidatedTokenRequest;
    if (grantType === 'refresh_token') {
      // Resolve the presented refresh token and retain its stored grant context.
      const { refreshTokenInfo } = await resolveRefreshToken(params, refreshTokenResolver);

      // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
      await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

      // Bind the refresh token to the authenticated client.
      validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

      // Absolute lifetime: expiresAt <= now is expired.
      validateRefreshTokenExpiration(refreshTokenInfo);

      // Optional inactivity policy. Replace undefined with your timeout in seconds
      // to enable it, or remove this step if your experiment has no idle lifetime.
      validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

      // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
      // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
      // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
      // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
      await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

      // RFC 6749 §6: requested scope may only narrow the original grant.
      const effectiveScope = validateRefreshTokenScope(params.scope, refreshTokenInfo.scope);

      validatedRequest = buildValidatedRefreshTokenRequest(
        refreshTokenInfo,
        authenticatedClientId,
        effectiveScope,
      );
    } else {
      // Resolve the presented authorization code and retain the non-optional code.
      const { code, authorizationCode } = await resolveAuthorizationCode(
        params,
        authorizationCodeResolver,
      );

      // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
      await validateAuthorizationCodeUnused(authorizationCode, authorizationCodeResolver);

      // Bind the authorization code to the authenticated client and its lifetime.
      validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
      validateAuthorizationCodeExpiration(authorizationCode);

      // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
      validateAuthorizationCodeRedirectUri(authorizationCode, params.redirect_uri);

      // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
      const codeVerified = await verifyAuthorizationCodePkce(
        authorizationCode,
        params.code_verifier,
      );

      // Mark used (do not physically delete) so a later replay remains detectable.
      await consumeAuthorizationCode(code, authorizationCodeResolver);

      validatedRequest = buildValidatedAuthorizationCodeRequest(
        code,
        authorizationCode,
        authenticatedClientId,
        codeVerified,
      );
    }
`
    : `    // Grant-specific validation (authorization_code only in this configuration).
    // Every security rule remains an independent customization point.
    const { code, authorizationCode } = await resolveAuthorizationCode(
      params,
      authorizationCodeResolver,
    );
    await validateAuthorizationCodeUnused(authorizationCode, authorizationCodeResolver);
    validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
    validateAuthorizationCodeExpiration(authorizationCode);
    validateAuthorizationCodeRedirectUri(authorizationCode, params.redirect_uri);
    const codeVerified = await verifyAuthorizationCodePkce(
      authorizationCode,
      params.code_verifier,
    );
    await consumeAuthorizationCode(code, authorizationCodeResolver);
    // The cast widens the result back to the ValidatedTokenRequest union: TypeScript
    // narrows a const to its initializer type, which would make the shared
    // refresh_token branches below unreachable (never) even though they compile.
    const validatedRequest = buildValidatedAuthorizationCodeRequest(
      code,
      authorizationCode,
      authenticatedClientId,
      codeVerified,
    ) as ValidatedTokenRequest;
`;
  const refreshIssuanceDecision = refresh
    ? `    // --- Refresh Token を発行するかの判定 -------------------------------------
    //
    // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
    // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
    // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
    // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
    // （RFC 9700 §4.14）、登録が無ければ発行しない。
    const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

    // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
    // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
    // 「元の grant が offline_access を持っていたか」で判断する。
    // - authorization_code grant: 今回付与された scope に offline_access があるか。
    // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
    //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
    //   元 grant の権限は失われないため rotation を継続する。
    const grantHasOfflineAccess =
      clientAllowsRefreshGrant &&
      (validatedRequest.grantType === 'refresh_token'
        ? validatedRequest.hadOfflineAccess
        : validatedRequest.scope.includes('offline_access'));

    // online refresh token の束縛先セッション。
    // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
    // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
    // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
    // contexts"）。この OP はその other contexts を online refresh token として実装し、
    // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
    // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
    // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
    const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

    // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
    // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
    // 付けられない RT を配らないための fail-closed。
    const issueRefreshToken =
      clientAllowsRefreshGrant &&
      (grantHasOfflineAccess ||
        (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

`
    : '';
  const refreshTokenValue = refresh
    ? 'issueRefreshToken ? generateRandomString(32) : undefined'
    : 'undefined /* the refresh_token feature is disabled: never issue one */';
  const refreshTokenPersistence = refresh
    ? `    // Store the new refresh token for rotation (OAuth 2.1 §4.3.1). grantId /
    // audience / authTime / nonce / acr / amr / azp propagate through rotations,
    // so descendants can be revoked on code reuse, the audience never expands,
    // and refresh で再発行する ID Token は OIDC Core 1.0 §12.1 に従い初回認証時の値を保持する。
    if (tokenResponse.refresh_token) {
      // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
      // refresh_token 経由は validatedRequest.authTime（前段で代入済み）。
      const rtAuthTime = authTime;
      if (rtAuthTime === undefined) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'authTime is required to issue a refresh token',
        );
      }
      // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
      // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
      // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
      // 漏洩 RT の長期 abuse を防ぐ。
      const originalIssuedAt =
        validatedRequest.grantType === 'refresh_token'
          ? validatedRequest.originalIssuedAt
          : issuedAt;
      // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
      // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
      // refresh token の scope には offline_access を保持する。access token は
      // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
      const refreshTokenScope =
        grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
          ? [...validatedRequest.scope, 'offline_access']
          : validatedRequest.scope;
      await refreshTokenStore.set(tokenResponse.refresh_token, {
        subject,
        clientId: validatedRequest.clientId,
        scope: refreshTokenScope,
        expiresAt: originalIssuedAt + config.refreshTokenAbsoluteLifetime,
        originalIssuedAt,
        used: false,
        grantId: validatedRequest.grantId,
        iat: issuedAt,
        issuer: config.issuer,
        audience: effectiveAudience,
        authTime: rtAuthTime,
        nonce,
        // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
        acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : resolvedAcr,
        amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : resolvedAmr,
        azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
        // online refresh token の束縛。undefined なら offline refresh token として
        // セッションから独立し、ログアウト後も使える。
        sessionId: boundSessionId,
      });
    }

    // OAuth 2.1 §4.3.1: ローテーションは新トークン保存成功後に旧 RT を失効する。
    // 失敗時にユーザーがリフレッシュ不能になることを防ぐため、必ずこの順序にする。
    if (validatedRequest.grantType === 'refresh_token' && params.refresh_token) {
      await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
    }

`
    : '';

  return `/**
 * Token Endpoint (OIDC Core 1.0 §3.1.3).
 *
 * Authenticates the client, validates the grant it presents and answers with
 * the token response: authorization_code and refresh_token here.${experimentalGrantDoc}
 */
import {
${coreImports.map((name) => `  ${name},`).join('\n')}
} from '${corePkg}';${experimentalImportBlock}
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

const { ${resolverNames.join(', ')} } = resolvers;
const { ${storeNames.join(', ')} } = stores;

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await token(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function token(request: Request): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: the Token Request body MUST be
  // application/x-www-form-urlencoded; anything else is rejected unparsed.
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Token requests must use application/x-www-form-urlencoded');
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  const { params: rawParams, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', \`Parameter "\${duplicateKey}" must not be repeated\`);
  }
  if (!isTokenRequestParams(rawParams)) {
    return oauthError('invalid_request', 'Missing required parameter: grant_type');
  }
  const params = rawParams;

  try {
    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
    // Each step below is an independent core function, called in the same order
    // as core's authenticateClient(). Replace verifyClientSecret with your own
    // assertion check (e.g. private_key_jwt) without touching the rest.

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

    // OIDC Core 1.0 §9: the method used must match the registered
    // token_endpoint_auth_method (blocks auth method downgrade / public-client mixups).
    validateClientAuthMethod(tokenClient, presentedCredentials);

    // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
    await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

    const authenticatedClientId = presentedCredentials.clientId;
${experimentalDispatchBlock}
    // --- Token request validation pipeline --------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's validateTokenRequest(). Delete a call to drop that validation,
    // or insert your own logic between steps.

${grantTypeSupportedStep}
    // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
    validateClientGrantType(tokenClient, grantType);

${grantValidationStep}
    // T-022: the ID Token is signed with the registered ID Token key whose alg
    // matches the client's id_token_signed_response_alg (RS256 by default).
    const idTokenAlg = (tokenClient as RegisteredClient).idTokenSignedResponseAlg;
    const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
    if (!idTokenKey) {
      return oauthError(
        'server_error',
        \`No ID Token signing key registered for alg "\${idTokenAlg ?? 'RS256'}"\`,
        500,
      );
    }

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
      userInfoEndpoint: \`\${config.issuer}/userinfo\`,
      requested: validatedRequest.audience,
      issuer: config.issuer,
    });

${refreshIssuanceDecision}    // --- Token response pipeline --------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's generateTokenResponse(). Add your own ID Token claims by editing
    // idTokenPayload before it is signed.

    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);

    // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id.
    // Add access token claims here before the payload is signed.
    const accessTokenPayload = buildAccessTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      audience: effectiveAudience,
      expiresIn: config.accessTokenExpiresIn,
      issuedAt,
    });

    // JWT or opaque, as chosen by config.accessTokenFormat (provider.ts).
    const accessToken = await accessTokenIssuer.issue({
      payload: accessTokenPayload,
      privateKey: keys.general[0].privateKey,
      keyId: keys.general[0].keyId,
    });

    // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
    // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
    // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
    let idToken: string | undefined;
    let resolvedAcr: string | undefined = undefined;
    let resolvedAmr: string[] | undefined = undefined;
    if (validatedRequest.scope.includes('openid')) {
      // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
      // The hash function follows the ID Token signing alg.
      const atHash = await computeAtHash(accessToken, idTokenKey.privateKey);

      // T-015: acr / amr.
      // - authorization_code: ask acrResolver (provider.ts); acr_values and the
      //   claims request are forwarded so it can honor them.
      // - refresh_token: the stored acr / amr are reused so OIDC Core 1.0 §12.1
      //   "preserve initial auth context" holds; the resolver is bypassed.
      ({ acr: resolvedAcr, amr: resolvedAmr } = await resolveAcrAmr({
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
      }));

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
        acr: resolvedAcr,
        amr: resolvedAmr,
      });

      // Add your own ID Token claims here, e.g.:
      //   idTokenPayload.tenant_id = await lookupTenant(subject);

      idToken = await generateIdToken({
        payload: idTokenPayload,
        privateKey: idTokenKey.privateKey,
        keyId: idTokenKey.keyId,
      });
    }

    // OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1: the token response body.
    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: ${refreshTokenValue},
    };

    // Store the access token for the UserInfo / Introspection / Revocation
    // endpoints. iat / nbf / audience / issuer are kept so RFC 7662
    // introspection can echo them; grantId ties the token to its authorization
    // grant so it is revoked with its siblings on code reuse (OAuth 2.1 §4.1.2).
    await accessTokenStore.set(tokenResponse.access_token, {
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
    });

${refreshTokenPersistence}    return noStoreJson(tokenResponse);
  } catch (error) {
${experimentalErrorMapping}    if (error instanceof TokenError) {
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
`;
}

/** `token/token-exchange.ts` — EXPERIMENTAL RFC 8693, only with --enable token-exchange. */
export function nextJsTokenExchangeGrantTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
 *
 * Generated because the OP was created with \`--enable token-exchange\`.
${EXPERIMENTAL_NOTICE}
 *
 * Known limitation: RFC 8693 §2.1 permits repeated \`resource\` / \`audience\`
 * parameters, but the token endpoint rejects any repeated parameter (RFC 6749
 * §3.2), so only a single value of each is supported.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  type TokenClientInfo,
} from '${corePkg}';
import {
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '${EXPERIMENTAL_PACKAGE}/token-exchange';
import {
  accessTokenIssuer,
  config,
  resolvers,
  stores,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import { noStoreJson } from '../_oidc-provider/http';

/**
 * Token Exchange settings.
 *
 * - allowedTargets: the audience / resource values a client may ask an
 *   exchanged token to be issued for. Empty by default (fail safe): with an
 *   empty list every exchange that names a target is rejected with
 *   invalid_target, and only scope-narrowing / lifetime-shortening exchanges
 *   succeed. Add the identifiers of your downstream services here.
 */
export const tokenExchangeConfig = {
  allowedTargets: [] as string[],
};

/**
 * Exchange the subject_token for a new access token. Errors are thrown as
 * TokenExchangeError and answered by the token route.
 */
export async function exchangeToken(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  // Validate the request and derive the issuing material. Each check inside is
  // also exported as its own step function, so you can call them one by one
  // instead and drop or replace individual rules.
  const grant = await processTokenExchangeRequest({
    params,
    client,
    accessTokenResolver: resolvers.accessTokenResolver,
    allowedTargets: tokenExchangeConfig.allowedTargets,
    configuredExpiresIn: config.accessTokenExpiresIn,
  });

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3), so an exchanged token still passes the
  // UserInfo endpoint's audience check.
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${config.issuer}/userinfo\`,
    requested: grant.requestedAudience,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    audience,
    expiresIn: grant.expiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: {
      ...payload,
      // RFC 8693 §4.1: a delegation exchange records the current actor in the
      // act claim (chains already nested by processTokenExchangeRequest).
      // Impersonation exchanges carry no act claim.
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  const metadata: ExchangedAccessTokenInfo = {
    // RFC 8693 §1.1: the exchanged token acts as the same subject, but is bound
    // to the client that requested the exchange.
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: issuedAt + grant.expiresIn,
    // Inherit the subject token's grant so revoking the grant (e.g. on code
    // reuse detection) also kills every token exchanged from it.
    grantId: grant.grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    // RFC 9068 §2.2 / RFC 7662 §2.2: the exchanged token gets its own jti, so it
    // is a distinct store record even when exchanged twice within one second.
    jti: payload.jti,
    // Persisting act lets a later exchange that presents THIS token as its
    // subject_token pick up the chain (RFC 8693 §4.1 nesting).
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
    // The subject token's stored claims parameter (OIDC Core 1.0 §5.5) is
    // deliberately NOT inherited: an exchanged token yields scope-based claims
    // only at the UserInfo endpoint.
  };
  await stores.accessTokenStore.set(accessToken, metadata);

  // RFC 8693 §2.2.1: access_token / issued_token_type / token_type are
  // REQUIRED; expires_in and scope are always included here.
  return noStoreJson(buildTokenExchangeResponse({
    accessToken,
    expiresIn: grant.expiresIn,
    scope: grant.scope,
  }));
}
`;
}

/** `token/id-jag.ts` — EXPERIMENTAL Cross-App Access, only with --enable id-jag. */
export function nextJsIdJagGrantTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // draft §4.3 MAY: refresh-token subjects only exist when the OP issues
  // refresh tokens at all.
  const refreshSubjects = features.refreshToken;
  const refreshConfigDoc = refreshSubjects
    ? `
 * - allowRefreshTokenSubjects: whether a refresh token this OP issued may stand
 *   in for the ID Token as the subject_token (draft §4.3 MAY), so a client can
 *   request a fresh ID-JAG after its ID Token expired without a new SSO round
 *   trip. Validated exactly like the standard refresh_token grant (rotation
 *   reuse revokes the token family; online tokens require the login session to
 *   be alive); the refresh token is NOT consumed. Grants without the openid
 *   scope are refused — their refresh token replaces no identity assertion.`
    : '';
  const refreshConfigField = refreshSubjects
    ? `
  allowRefreshTokenSubjects: true,`
    : '';
  const refreshSubjectArgs = refreshSubjects
    ? `
    ...(idJagConfig.allowRefreshTokenSubjects
      ? {
          refreshTokenResolver: resolvers.refreshTokenResolver,
          authenticationSessionResolver: resolvers.authenticationSessionResolver,
        }
      : {}),`
    : '';
  const resolversImport = refreshSubjects ? '\n  resolvers,' : '';
  return `/**
 * EXPERIMENTAL — Identity Assertion JWT Authorization Grant (ID-JAG), the
 * Cross-App Access flow (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Generated because the OP was created with \`--enable id-jag\`. The OP plays
 * both roles:
 * - as the IdP it issues ID-JAGs on the token-exchange grant (issueIdJag);
 * - as a resource authorization server it redeems ID-JAGs from trusted IdPs on
 *   the jwt-bearer grant (redeemIdJag).
 *
${EXPERIMENTAL_NOTICE} The underlying specification is an IETF draft and may
 * itself change.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  selectSigningKeyByAlg,
  type JwkSet,
  type SigningKey,
  type TokenClientInfo,
} from '${corePkg}';
import {
  TOKEN_TYPE_ID_TOKEN,
  processIdJagIssuanceRequest,
  processIdJagRedemptionRequest,
  resolveIdJagActor,
  type IdJagAccessTokenInfo,
  type IdJagActorTokenResolver,
  type IdJagTrustedIdentityProvider,
} from '${EXPERIMENTAL_PACKAGE}/id-jag';
import {
  accessTokenIssuer,
  config,
  idTokenHintJwks,${resolversImport}
  stores,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import { noStoreJson, oauthError } from '../_oidc-provider/http';

/**
 * Cross-App Access settings.
 *
 * Issuing side (this OP as the IdP, draft §4.3):
 * - allowedAudiences: resource authorization server issuers this IdP may issue
 *   an ID-JAG for. Empty by default (fail safe): every issuance request is
 *   rejected with invalid_target until you list the peer AS issuers here.
 *   Adding an entry grants that cross-app connection on behalf of every user —
 *   there is no per-user consent screen in this flow.
 * - idJagLifetimeSeconds: ID-JAG lifetime. Keep it short (draft example: 300);
 *   clients are expected to request a fresh one instead of holding it.
 * - allowedScopes: optional cap on the scopes an ID-JAG may carry. undefined
 *   passes the requested scopes through (the resource AS applies its own
 *   policy again on redemption).${refreshConfigDoc}
 * - allowActorTokens: whether an actor_token (identifying who acts on the
 *   subject's behalf) is accepted and recorded as the ID-JAG's act claim
 *   (RFC 8693 §4.1). The draft defines no normative actor processing (§9.7
 *   sketches extensions), so this is an opt-in extension and defaults to
 *   false — an actor_token is rejected until you flip it, whatever else is
 *   configured. Every token type identifier RFC 8693 §3 defines is accepted
 *   the same way; the type alone decides nothing.
 * - actorTokenResolver: validates the actor_token's CONTENT (signature,
 *   revocation, whose token it is) — for every accepted type, this OP's own
 *   ID Tokens included. The library only checks the request structure and the
 *   shape of what you return. Return the act value ({ sub, act? }) for a valid
 *   token, null for an invalid one (answered with a fixed invalid_request), or
 *   throw IdJagError to pick the response yourself. The default below handles
 *   ID Tokens this OP issued to the authenticated client; extend or replace it
 *   to cover the other types. Clearing it rejects every actor_token.
 *
 * Consuming side (this OP as the resource authorization server, draft §4.4):
 * - trustedIdentityProviders: the IdPs whose ID-JAGs are accepted on the
 *   jwt-bearer grant. Empty by default (fail safe). Keys come from the inline
 *   \`jwks\` when present, otherwise from \`jwksUri\` (fetched and cached below).
 *   Never derive the key source from the assertion itself.
 */
const defaultIdJagActorTokenResolver: IdJagActorTokenResolver = async ({
  actorToken,
  actorTokenType,
  clientId,
  issuer,
  jwks,
}) =>
  actorTokenType === TOKEN_TYPE_ID_TOKEN
    ? resolveIdJagActor({ actorToken, issuer, clientId, jwks })
    : null;

export const idJagConfig = {
  allowedAudiences: [] as string[],
  idJagLifetimeSeconds: 300,
  allowedScopes: undefined as string[] | undefined,${refreshConfigField}
  allowActorTokens: false,
  actorTokenResolver: defaultIdJagActorTokenResolver as IdJagActorTokenResolver | undefined,
  trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,
};

/**
 * Issue an ID-JAG (draft §4.3): the subject_token must be an ID Token this OP
 * issued to the authenticated client, and the answer is a signed grant JWT for
 * the resource authorization server named by \`audience\` — not an access token
 * (the response carries token_type N_A). Errors are thrown as IdJagError and
 * answered by the token route.
 */
export async function issueIdJag(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  // Signed with a registered RS256 key so the peer AS can verify it against
  // this OP's JWKS endpoint (same key-selection contract as JARM: RS256 is
  // pinned, the first key of the set may be another alg).
  let signingKey: SigningKey;
  try {
    signingKey = selectSigningKeyByAlg(keys.general, 'RS256');
  } catch {
    return oauthError('server_error', 'No RS256 signing key registered for ID-JAG issuance', 500);
  }

  const response = await processIdJagIssuanceRequest({
    params,
    client,
    issuer: config.issuer,
    // The subject_token is verified against the keys id_token_hint uses (this
    // OP's own ID Token keys); draft §4.3.3 requires its audience to be the
    // authenticated client, which processIdJagIssuanceRequest checks.
    jwks: await idTokenHintJwks(keys),
    signingKey,
    allowedAudiences: idJagConfig.allowedAudiences,
    allowedScopes: idJagConfig.allowedScopes,
    lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
    // Extension (draft §9.7): when enabled, an actor_token is recorded as the
    // ID-JAG's act claim. Every accepted token type goes through the same
    // resolver, which owns the content validation.
    allowActorTokens: idJagConfig.allowActorTokens,
    ...(idJagConfig.actorTokenResolver === undefined
      ? {}
      : { actorTokenResolver: idJagConfig.actorTokenResolver }),${refreshSubjectArgs}
  });

  // The ID-JAG itself is not persisted: it is a self-contained signed grant the
  // peer AS verifies by signature and exp.
  return noStoreJson(response);
}

/**
 * Redeem an ID-JAG on the jwt-bearer grant (RFC 7523 §2.1 / draft §4.4). The
 * assertion must be issued by one of idJagConfig.trustedIdentityProviders for
 * THIS issuer and the authenticated client; this OP then issues its own access
 * token. No ID Token (this is not an OIDC authentication) and no refresh token
 * (draft §4.4.3 SHOULD NOT — the still-valid ID-JAG can be presented again).
 */
export async function redeemIdJag(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const grant = await processIdJagRedemptionRequest({
    params,
    client,
    issuer: config.issuer,
    identityProviders: await resolveTrustedIdentityProviders(),
    configuredExpiresIn: config.accessTokenExpiresIn,
  });

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3); the ID-JAG's resource claim (RFC 8707)
  // contributes the requested resources.
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${config.issuer}/userinfo\`,
    requested: grant.requestedResources,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    audience,
    expiresIn: grant.expiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: {
      ...payload,
      // RFC 8693 §4.1: an act claim carried by the ID-JAG is preserved, so
      // downstream services still see WHO acts on the subject's behalf
      // (dropping it would silently turn the delegation into impersonation).
      ...(grant.actor === undefined ? {} : { act: grant.actor }),
    },
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  const metadata: IdJagAccessTokenInfo = {
    // draft §4.4.1: the ID-JAG's sub is used as the local subject directly
    // (subject resolution by identical sub; JIT provisioning is out of scope).
    sub: grant.subject,
    clientId: grant.clientId,
    scope: grant.scope,
    expiresAt: issuedAt + grant.expiresIn,
    // Each redemption is its own grant: revoking one issued token must not
    // affect tokens from other redemptions of the same (re-presentable) ID-JAG,
    // so the payload's own jti doubles as the grant id.
    grantId: payload.jti,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: payload.jti,
    // The actor is persisted too, so opaque-token introspection and store-based
    // tooling can surface it just like the JWT claim.
    ...(grant.actor === undefined ? {} : { act: grant.actor }),
  };
  await stores.accessTokenStore.set(accessToken, metadata);

  return noStoreJson({
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: grant.expiresIn,
    scope: grant.scope.join(' '),
  });
}

/**
 * jwks_uri cache for trusted identity providers. A fetched JWKS is reused for
 * 300 seconds, so a key rotation at the IdP can take up to that long to be
 * picked up. The fetch target comes exclusively from idJagConfig above — never
 * from request or assertion content — which keeps this endpoint SSRF-free.
 */
const idJagJwksCache = new Map<string, { jwks: JwkSet; expiresAt: number }>();
const ID_JAG_JWKS_CACHE_TTL_MS = 300_000;

async function resolveTrustedIdentityProviders(): Promise<IdJagTrustedIdentityProvider[]> {
  const resolved: IdJagTrustedIdentityProvider[] = [];
  for (const entry of idJagConfig.trustedIdentityProviders) {
    if (entry.jwks !== undefined) {
      resolved.push({ issuer: entry.issuer, jwks: entry.jwks });
      continue;
    }
    if (entry.jwksUri === undefined) {
      // An entry with neither jwks nor jwksUri can never verify anything; skip
      // it so the assertion is answered with the fixed untrusted description.
      continue;
    }
    const cached = idJagJwksCache.get(entry.jwksUri);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      resolved.push({ issuer: entry.issuer, jwks: cached.jwks });
      continue;
    }
    // A failed fetch propagates: the token route turns it into server_error,
    // which is honest — the assertion was never evaluated, so invalid_grant
    // would wrongly blame the client for an outage on this side.
    const response = await fetch(entry.jwksUri);
    if (!response.ok) {
      throw new Error(\`Fetching the JWKS of trusted IdP \${entry.issuer} failed with status \${response.status}\`);
    }
    const jwks = (await response.json()) as JwkSet;
    idJagJwksCache.set(entry.jwksUri, { jwks, expiresAt: Date.now() + ID_JAG_JWKS_CACHE_TTL_MS });
    resolved.push({ issuer: entry.issuer, jwks });
  }
  return resolved;
}
`;
}

/**
 * Shared body of the two grants that redeem an End-User approval given on
 * another device (device_code and CIBA): they issue the same token set.
 */
function approvedGrantTokens(input: {
  grant: string;
  /** The refresh-token feature: without it no refresh token is ever issued. */
  refreshTokens: boolean;
  idTokenNote: string;
  nonceNote: string;
  audienceNote: string;
  offlineNote: string;
  grantIdNote: string;
}): string {
  return `  // T-022: the ID Token follows the same key-selection rule as the standard
  // grants — the registered ID Token key whose alg matches the client's
  // id_token_signed_response_alg, not simply the first key of the set.
  const idTokenAlg = (client as RegisteredClient).idTokenSignedResponseAlg;
  const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
  if (!idTokenKey) {
    return oauthError(
      'server_error',
      \`No ID Token signing key registered for alg "\${idTokenAlg ?? 'RS256'}"\`,
      500,
    );
  }

  // Same aud policy as the standard grants: the UserInfo endpoint stays a
  // permanent member (RFC 9068 §3). ${input.audienceNote}
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: \`\${config.issuer}/userinfo\`,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: ${input.grant}.subject,
    clientId: ${input.grant}.clientId,
    scope: ${input.grant}.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  // ${input.idTokenNote}
  const { acr, amr } = await resolveAcrAmr({
    subject: ${input.grant}.subject,
    clientId: ${input.grant}.clientId,
    acrResolver,
  });
  const idToken = await generateIdToken({
    payload: buildIdTokenPayload({
      issuer: config.issuer,
      subject: ${input.grant}.subject,
      clientId: ${input.grant}.clientId,
      scope: ${input.grant}.scope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      atHash: await computeAtHash(accessToken, idTokenKey.privateKey),
      authTime: ${input.grant}.authTime,
      acr,
      amr,
    }),
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });

  await stores.accessTokenStore.set(accessToken, {
    sub: ${input.grant}.subject,
    clientId: ${input.grant}.clientId,
    scope: ${input.grant}.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    // ${input.grantIdNote}
    grantId: ${input.grant}.grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: accessTokenPayload.jti,
  });

${input.refreshTokens ? `  // OIDC Core 1.0 §11: offline_access survived the request endpoint's policy
  // check only if this client may hold refresh tokens, and ${input.offlineNote}
  // IS the explicit consent §11 asks for. Nothing further to gate on here.
  const refreshToken = ${input.grant}.scope.includes('offline_access')
    ? generateRandomString(32)
    : undefined;
  if (refreshToken) {
    await stores.refreshTokenStore.set(refreshToken, {
      subject: ${input.grant}.subject,
      clientId: ${input.grant}.clientId,
      scope: ${input.grant}.scope,
      // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
      // inherit originalIssuedAt so the deadline never slides forward.
      expiresAt: issuedAt + config.refreshTokenAbsoluteLifetime,
      originalIssuedAt: issuedAt,
      used: false,
      grantId: ${input.grant}.grantId,
      iat: issuedAt,
      issuer: config.issuer,
      audience,
      authTime: ${input.grant}.authTime,
      // ${input.nonceNote}
      nonce: undefined,
      acr,
      amr,
      azp: undefined,
    });
  }

` : ''}  return noStoreJson({
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: config.accessTokenExpiresIn,
    id_token: idToken,
    scope: ${input.grant}.scope.join(' '),${input.refreshTokens ? `
    refresh_token: refreshToken,` : ''}
  });`;
}

/** `token/device-code.ts` — EXPERIMENTAL RFC 8628, only with --enable device-authorization-grant. */
export function nextJsDeviceCodeGrantTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // Refresh tokens are issued under exactly the conditions of the standard
  // grants, so they only exist when the refresh-token feature does.
  const randomStringImport = features.refreshToken ? '\n  generateRandomString,' : '';
  return `/**
 * EXPERIMENTAL — the device_code grant of the OAuth 2.0 Device Authorization
 * Grant (RFC 8628 §3.4 / §3.5).
 *
 * Generated because the OP was created with \`--enable device-authorization-grant\`.
${EXPERIMENTAL_NOTICE}
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,${randomStringImport}
  resolveAcrAmr,
  type TokenClientInfo,
} from '${corePkg}';
import { processDeviceCodeGrant } from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  accessTokenIssuer,
  acrResolver,
  config,
  deviceAuthorizationStore,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import { noStoreJson, oauthError } from '../_oidc-provider/http';

/**
 * Redeem an approved device authorization for tokens. Every state but
 * "approved" is thrown as DeviceAuthorizationError — authorization_pending /
 * slow_down / access_denied / expired_token, plus invalid_request /
 * invalid_grant / unauthorized_client from §3.4 — and answered by the token
 * route.
 */
export async function redeemDeviceCode(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const deviceGrant = await processDeviceCodeGrant({
    params,
    client,
    store: deviceAuthorizationStore,
  });

${approvedGrantTokens({
  grant: 'deviceGrant',
  refreshTokens: features.refreshToken,
  audienceNote: 'RFC 8628 has no resource parameter, so nothing else is\n  // requested.',
  idTokenNote: `The device authorization endpoint requires the openid scope, so an ID Token
  // is always issued. It carries no nonce (RFC 8628 defines no such parameter,
  // and OIDC Core 1.0 §2 only requires nonce when the authentication request
  // carried one) and no c_hash (there is no code).`,
  grantIdNote: 'Inherit the grantId minted at approval so revoking the grant kills\n    // every token issued from this device authorization.',
  offlineNote: 'the approval screen the user\n  // just went through',
  nonceNote: 'RFC 8628 has no nonce parameter, so the re-issued ID Token has none\n      // to preserve either.',
})}
}
`;
}

/** `token/ciba.ts` — EXPERIMENTAL CIBA Core 1.0, only with --enable ciba. */
export function nextJsCibaGrantTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // Refresh tokens are issued under exactly the conditions of the standard
  // grants, so they only exist when the refresh-token feature does.
  const randomStringImport = features.refreshToken ? '\n  generateRandomString,' : '';
  return `/**
 * EXPERIMENTAL — the CIBA grant (OpenID Connect Client-Initiated Backchannel
 * Authentication Core 1.0 §10.1, poll mode).
 *
 * Generated because the OP was created with \`--enable ciba\`.
${EXPERIMENTAL_NOTICE}
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,${randomStringImport}
  resolveAcrAmr,
  type TokenClientInfo,
} from '${corePkg}';
import { processCibaGrant } from '${EXPERIMENTAL_PACKAGE}/ciba';
import type { RegisteredClient } from '../_oidc-provider/config';
import {
  accessTokenIssuer,
  acrResolver,
  cibaAuthenticationRequestStore,
  config,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../_oidc-provider/provider';
import { noStoreJson, oauthError } from '../_oidc-provider/http';

/**
 * Redeem an approved backchannel authentication request for tokens. Every
 * state but "approved" is thrown as CibaGrantError — authorization_pending /
 * slow_down / access_denied / expired_token, plus invalid_request /
 * invalid_grant (CIBA §11) — and answered by the token route.
 */
export async function redeemCibaRequest(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response> {
  const cibaGrant = await processCibaGrant({
    params,
    client,
    store: cibaAuthenticationRequestStore,
  });

${approvedGrantTokens({
  grant: 'cibaGrant',
  refreshTokens: features.refreshToken,
  audienceNote: 'CIBA §7.1 has no resource parameter, so nothing else is\n  // requested.',
  idTokenNote: `The backchannel authentication endpoint requires the openid scope, so an ID
  // Token is always issued. It carries no nonce (CIBA §7.1 defines no such
  // parameter, and OIDC Core 1.0 §2 only requires nonce when the authentication
  // request carried one) and no c_hash (there is no code). Poll mode adds no
  // CIBA-specific claims either — the auth_req_id claim of §10.3.1 belongs to
  // the push-mode token delivery message.`,
  grantIdNote: 'Inherit the grantId minted at approval so revoking the grant kills\n    // every token issued from this backchannel authentication.',
  offlineNote: 'the approval screen the user\n  // just went through',
  nonceNote: 'CIBA §7.1 defines no nonce parameter, so the re-issued ID Token has\n      // none to preserve either.',
})}
}
`;
}
