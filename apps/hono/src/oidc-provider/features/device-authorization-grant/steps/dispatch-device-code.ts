import {
  type TokenClientInfo,
  selectSigningKeyByAlg,
  type SigningKey,
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  type AccessTokenIssuer,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  resolveAcrAmr,
  generateRandomString,
  type AcrResolver,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceAuthorizationError,
  processDeviceCodeGrant,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { type TokenRequestBody, TokenEndpointError } from '../../../endpoints/token/response.js';
import { respondToken } from '../../../endpoints/token/steps/respond.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'dispatch-device-code',
  endpoint: 'token',
  feature: 'device-authorization-grant',
  kind: 'dispatch',
  label: 'Redeem a device_code',
  spec: 'RFC 8628 §3.4 / §3.5',
  function: 'redeemDeviceCode',
  consumes: ['params', 'tokenClient', 'authenticatedClientId'],
  produces: [],
  removable: false,
  before: ['validate-grant-type'],
});

/**
 * デバイスコードのグラントなら、トークンを発行して応答する。
 *
 * `grant_type` がデバイスコードの URN でなければ、何もせず `undefined` を返す。
 * トークンエンドポイントのパイプラインは、このステップをクライアント認証の直後、`grant_type` の検証より前に実行する。
 * `grant_type` の検証はこの URN を知らず、`unsupported_grant_type` で拒否してしまうためである。
 * デバイスコードのグラントなら、このステップが応答まで行い、標準のグラントの処理には進まない。
 *
 * `device_code` のレコードが承認済みなら、アクセストークンと ID トークン（`scope` に `offline_access` があればリフレッシュトークンも）を発行してストアに保存し、200 のトークンレスポンスで応答する。
 * 承認済みでなければ、`processDeviceCodeGrant()` が投げる `DeviceAuthorizationError` を、同じコードとステータス（400）の `TokenEndpointError` にして投げる。
 * クライアントの `id_token_signed_response_alg` に合う ID トークンの署名鍵がなければ、500 の `server_error` を表す `TokenEndpointError` を投げる。
 * 投げた `TokenEndpointError` は、トークンエンドポイントのエラー応答のステップがそのまま返す。
 *
 * experimental パッケージの API は安定しておらず、リリースの間で互換性のない変更が入ることがある。
 * 本番のコードで使うときは、バージョンを固定する。
 *
 * @spec RFC 8628 §3.4
 * @spec RFC 8628 §3.5
 * @throws {TokenEndpointError} `authorization_pending`、`slow_down`、`access_denied`、`expired_token`、`invalid_request`、`invalid_grant`、`unauthorized_client`: `device_code` のレコードが承認済みでないか、使えないとき（ステータスは 400）。
 * @throws {TokenEndpointError} `server_error`: クライアントの `alg` に合う ID トークンの署名鍵がないとき（ステータスは 500）。
 */
export async function redeemDeviceCode(
  c: any,
  params: TokenRequestBody,
  tokenClient: TokenClientInfo,
  authenticatedClientId: string,
): Promise<Response | undefined> {
  if (params.grant_type !== DEVICE_CODE_GRANT_TYPE) return undefined;

  try {
    const tokenClientResolver = c.get('tokenClientResolver');
    const accessTokenStore = c.get('accessTokenStore');
    const deviceStore = c.get('deviceAuthorizationStore');

    // `device_code` のレコードの状態を判定し、承認済みならトークンの発行に必要な値を受け取る（RFC 8628 §3.5 の状態機械）。
    // 承認済み以外では `DeviceAuthorizationError`（`authorization_pending`、`slow_down`、`access_denied`、`expired_token` と、§3.4 の `invalid_request`、`invalid_grant`、`unauthorized_client`）が投げられる。
    const deviceGrant = await processDeviceCodeGrant({
      params,
      client: tokenClient,
      store: deviceStore,
    });

    const deviceConfig = c.get('config');
    // 新しいトークンには、登録された最初の鍵で署名する（`SigningKeyProvider` の契約）。
    const deviceSigningKey: SigningKey = c.get('signingKeys')[0];
    const devicePrivateKey = deviceSigningKey.privateKey;
    const deviceKeyId = deviceSigningKey.keyId;
    // T-022: the ID Token this grant issues follows the SAME key-selection rule
    // as the standard grants — pick a registered ID Token key whose alg matches
    // the client's id_token_signed_response_alg (OIDC Dynamic Client
    // Registration 1.0 §2), not simply the first key of the set. Using the
    // first key would hand an ES256-registered client an RS256 ID Token, which
    // it rejects, and would hash at_hash with the wrong algorithm.
    const deviceIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const deviceRegisteredClient = (await tokenClientResolver.findClient(
      authenticatedClientId,
    )) as RegisteredClient | null;
    const deviceRequestedIdTokenAlg = deviceRegisteredClient?.idTokenSignedResponseAlg;
    let deviceSelectedIdTokenKey: SigningKey;
    try {
      deviceSelectedIdTokenKey = selectSigningKeyByAlg(deviceIdTokenSigningKeys, deviceRequestedIdTokenAlg);
    } catch {
      throw new TokenEndpointError({
        status: 500,
        body: {
          error: 'server_error',
          error_description: `No ID Token signing key registered for alg "${deviceRequestedIdTokenAlg ?? 'RS256'}"`,
        },
      });
    }
    const deviceIdTokenPrivateKey = deviceSelectedIdTokenKey.privateKey;
    const deviceIdTokenKeyId = deviceSelectedIdTokenKey.keyId;
    const deviceIssuer: AccessTokenIssuer =
      deviceConfig.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // Same aud policy as the standard grants: the UserInfo endpoint stays a
    // permanent member (RFC 9068 §3). RFC 8628 has no resource parameter, so
    // nothing else is requested.
    const deviceAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${deviceConfig.issuer}/userinfo`,
      issuer: deviceConfig.issuer,
    });

    const deviceIssuedAt = Math.floor(Date.now() / 1000);
    const deviceAccessTokenPayload = buildAccessTokenPayload({
      issuer: deviceConfig.issuer,
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      audience: deviceAudience,
      expiresIn: deviceConfig.accessTokenExpiresIn,
      issuedAt: deviceIssuedAt,
    });
    const deviceAccessToken = await deviceIssuer.issue({
      payload: deviceAccessTokenPayload,
      privateKey: devicePrivateKey,
      keyId: deviceKeyId,
    });

    // The device authorization endpoint requires the openid scope, so an ID
    // Token is always issued. It carries no nonce (RFC 8628 defines no such
    // parameter, and OIDC Core 1.0 §2 only requires nonce when the
    // authentication request carried one) and no c_hash (there is no code).
    const deviceAtHash = await computeAtHash(deviceAccessToken, deviceIdTokenPrivateKey);
    const deviceAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const { acr: deviceAcr, amr: deviceAmr } = await resolveAcrAmr({
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      acrResolver: deviceAcrResolver,
    });
    const deviceIdTokenPayload = buildIdTokenPayload({
      issuer: deviceConfig.issuer,
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      expiresIn: deviceConfig.idTokenExpiresIn,
      issuedAt: deviceIssuedAt,
      atHash: deviceAtHash,
      authTime: deviceGrant.authTime,
      acr: deviceAcr,
      amr: deviceAmr,
    });
    const deviceIdToken = await generateIdToken({
      payload: deviceIdTokenPayload,
      privateKey: deviceIdTokenPrivateKey,
      keyId: deviceIdTokenKeyId,
    });

    await accessTokenStore.set(deviceAccessToken, {
      sub: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      expiresAt: deviceIssuedAt + deviceConfig.accessTokenExpiresIn,
      // Inherit the grantId minted at approval so revoking the grant kills
      // every token issued from this device authorization.
      grantId: deviceGrant.grantId,
      iat: deviceIssuedAt,
      nbf: deviceIssuedAt,
      audience: deviceAudience,
      issuer: deviceConfig.issuer,
      jti: deviceAccessTokenPayload.jti,
    });

    // OIDC Core 1.0 §11: offline_access survived the device authorization
    // endpoint's policy check only if this client may hold refresh tokens, and
    // the approval screen the user just went through IS the explicit consent
    // that §11 asks for. Nothing further to gate on here.
    const deviceRefreshToken = deviceGrant.scope.includes('offline_access')
      ? generateRandomString(32)
      : undefined;
    if (deviceRefreshToken) {
      const deviceRefreshTokenStore = c.get('refreshTokenStore');
      await deviceRefreshTokenStore.set(deviceRefreshToken, {
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
        // inherit originalIssuedAt so the deadline never slides forward.
        expiresAt: deviceIssuedAt + deviceConfig.refreshTokenAbsoluteLifetime,
        originalIssuedAt: deviceIssuedAt,
        used: false,
        grantId: deviceGrant.grantId,
        iat: deviceIssuedAt,
        issuer: deviceConfig.issuer,
        audience: deviceAudience,
        authTime: deviceGrant.authTime,
        // RFC 8628 has no nonce parameter, so the re-issued ID Token has none
        // to preserve either.
        nonce: undefined,
        acr: deviceAcr,
        amr: deviceAmr,
        azp: undefined,
      });
    }

    return respondToken(c, {
      status: 200,
      body: {
        access_token: deviceAccessToken,
        token_type: 'Bearer' as const,
        expires_in: deviceConfig.accessTokenExpiresIn,
        id_token: deviceIdToken,
        scope: deviceGrant.scope.join(' '),
        refresh_token: deviceRefreshToken,
      },
    });
  } catch (error) {
    // RFC 8628 §3.5: authorization_pending / slow_down / access_denied /
    // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
    // only come from client authentication, which runs before the branch and
    // throws core's TokenError.
    if (error instanceof DeviceAuthorizationError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
