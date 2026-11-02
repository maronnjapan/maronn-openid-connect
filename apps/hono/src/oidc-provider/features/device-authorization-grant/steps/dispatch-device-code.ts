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
 * グラントタイプがデバイスコードなら、トークンで応答する。
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
    // ID トークンの署名鍵は、標準のグラントと同じ規則で選ぶ（T-022）。
    // 登録された ID トークン用の鍵のうち、`alg` がクライアントの `id_token_signed_response_alg` と一致するものを使う（OpenID Connect Dynamic Client Registration 1.0 §2）。
    // 鍵の集合の最初の鍵を使うと、ES256 で登録したクライアントに RS256 の ID トークンを渡すことになり、クライアントはそれを拒否する。
    // `at_hash` も誤ったアルゴリズムで計算してしまう。
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

    // アクセストークンの `aud` を、標準のグラントと同じ方針で組み立てる。
    // UserInfo エンドポイントを常に含める（RFC 9068 §3）。
    // RFC 8628 には `resource` パラメータがないので、ほかのオーディエンスは要求されない。
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

    // ID トークンは必ず発行する。
    // デバイス認可エンドポイントが `openid` スコープを必須にしているためである。
    // RFC 8628 には `nonce` パラメータがなく、OIDC Core 1.0 §2 が `nonce` を求めるのは認証リクエストに `nonce` があったときだけなので、`nonce` は含めない。
    // 認可コードがないので、`c_hash` も含めない。
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
      // 承認のときに作ったグラント ID を引き継ぎ、そのグラントを失効させれば、このデバイス認可から発行したトークンがすべて失効するようにする。
      grantId: deviceGrant.grantId,
      iat: deviceIssuedAt,
      nbf: deviceIssuedAt,
      audience: deviceAudience,
      issuer: deviceConfig.issuer,
      jti: deviceAccessTokenPayload.jti,
    });

    // `scope` に `offline_access` があれば、リフレッシュトークンを発行する（OIDC Core 1.0 §11）。
    // `offline_access` がここまで残るのは、デバイス認可エンドポイントの方針の確認で、このクライアントがリフレッシュトークンを持てると判定されたときだけである。
    // エンドユーザーが通った承認画面が §11 の求める明示的な同意にあたるので、ここで確かめることはほかにない。
    const deviceRefreshToken = deviceGrant.scope.includes('offline_access')
      ? generateRandomString(32)
      : undefined;
    if (deviceRefreshToken) {
      const deviceRefreshTokenStore = c.get('refreshTokenStore');
      await deviceRefreshTokenStore.set(deviceRefreshToken, {
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        // 有効期限は、最初の発行から数えた絶対的な期間で決める（OAuth 2.1 §6.1）。
        // ローテーションでは `originalIssuedAt` を引き継ぐので、期限が後ろにずれることはない。
        expiresAt: deviceIssuedAt + deviceConfig.refreshTokenAbsoluteLifetime,
        originalIssuedAt: deviceIssuedAt,
        used: false,
        grantId: deviceGrant.grantId,
        iat: deviceIssuedAt,
        issuer: deviceConfig.issuer,
        audience: deviceAudience,
        authTime: deviceGrant.authTime,
        // RFC 8628 には `nonce` パラメータがないので、再発行する ID トークンにも引き継ぐ `nonce` はない。
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
    // `DeviceAuthorizationError` を、同じコードとステータスの `TokenEndpointError` にして投げ直す。
    // `authorization_pending`、`slow_down`、`access_denied`、`expired_token` は RFC 6749 §5.2 の形のエラーで、ステータスは常に 400 である（RFC 8628 §3.5）。
    // 401 になるのはクライアント認証の失敗だけで、それはこの分岐より前に core の `TokenError` として投げられる。
    if (error instanceof DeviceAuthorizationError) {
      throw new TokenEndpointError({
        status: error.statusCode,
        body: { error: error.code, error_description: error.errorDescription },
      });
    }
    throw error;
  }
}
