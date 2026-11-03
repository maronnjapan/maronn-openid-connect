/**
 * EXPERIMENTAL — the device_code grant of the OAuth 2.0 Device Authorization
 * Grant (RFC 8628 §3.4 / §3.5).
 *
 * Generated because the OP was created with `--enable device-authorization-grant`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in
 * a breaking way between releases. Do not build production code on it without
 * pinning the version.
 */
import {
  buildAccessTokenAudience,
  buildAccessTokenPayload,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  generateRandomString,
  resolveAcrAmr,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceAuthorizationError,
  processDeviceCodeGrant,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import type { RegisteredClient } from '../../config';
import {
  accessTokenIssuer,
  acrResolver,
  config,
  selectIdTokenSigningKey,
  stores,
  type ProviderSigningKeys,
} from '../../provider';
import { deviceAuthorizationStore } from './store';
import { noStoreJson, oauthError } from '../../http';

/**
 * 承認済みの `device_code` でトークンを発行して返す。
 *
 * `processDeviceCodeGrant()` で `device_code` のレコードの状態を判定し、承認済みなら、アクセストークンと ID トークン（`scope` に `offline_access` があればリフレッシュトークンも）を発行してストアに保存し、200 のトークンレスポンス（キャッシュ禁止の JSON）で応答する。
 * 承認済みでなければ `DeviceAuthorizationError` を投げ、`dispatchDeviceCode()` がそれを OAuth のエラーレスポンスにして返す。
 * クライアントの `id_token_signed_response_alg` に合う ID トークンの署名鍵がなければ、500 の `server_error` で応答する。
 *
 * @spec RFC 8628 §3.4
 * @spec RFC 8628 §3.5
 * @throws {DeviceAuthorizationError} `authorization_pending`、`slow_down`、`access_denied`、`expired_token`、`invalid_request`、`invalid_grant`、`unauthorized_client`: `device_code` のレコードが承認済みでないか、使えないとき。
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

  // ID トークンの署名鍵は、標準のグラントと同じ規則で選ぶ。
  // 登録された ID トークン用の鍵のうち、`alg` がクライアントの `id_token_signed_response_alg` と一致するものを使う（OIDC Dynamic Client Registration 1.0 §2）。
  // 鍵の集合の最初の鍵を使うと、ES256 で登録したクライアントに RS256 の ID トークンを渡すことになり、クライアントはそれを拒否する。
  // `at_hash` も誤ったアルゴリズムで計算してしまう。
  const idTokenAlg = (client as RegisteredClient).idTokenSignedResponseAlg;
  const idTokenKey = selectIdTokenSigningKey(keys, idTokenAlg);
  if (!idTokenKey) {
    return oauthError(
      'server_error',
      `No ID Token signing key registered for alg "${idTokenAlg ?? 'RS256'}"`,
      500,
    );
  }

  // アクセストークンの `aud` を、標準のグラントと同じ方針で組み立てる。
  // UserInfo エンドポイントを常に含める（RFC 9068 §3）。
  // RFC 8628 には `resource` パラメータがないので、ほかのオーディエンスは要求されない。
  const audience = buildAccessTokenAudience({
    userInfoEndpoint: `${config.issuer}/userinfo`,
    issuer: config.issuer,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const accessTokenPayload = buildAccessTokenPayload({
    issuer: config.issuer,
    subject: deviceGrant.subject,
    clientId: deviceGrant.clientId,
    scope: deviceGrant.scope,
    audience,
    expiresIn: config.accessTokenExpiresIn,
    issuedAt,
  });
  const accessToken = await accessTokenIssuer.issue({
    payload: accessTokenPayload,
    privateKey: keys.general[0].privateKey,
    keyId: keys.general[0].keyId,
  });

  // ID トークンは必ず発行する。
  // デバイス認可エンドポイントが `openid` スコープを必須にしているためである。
  // RFC 8628 には `nonce` パラメータがなく、OIDC Core 1.0 §2 が `nonce` を求めるのは認証リクエストに `nonce` があったときだけなので、`nonce` は含めない。
  // 認可コードがないので、`c_hash` も含めない。
  const { acr, amr } = await resolveAcrAmr({
    subject: deviceGrant.subject,
    clientId: deviceGrant.clientId,
    acrResolver,
  });
  const idToken = await generateIdToken({
    payload: buildIdTokenPayload({
      issuer: config.issuer,
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      expiresIn: config.idTokenExpiresIn,
      issuedAt,
      atHash: await computeAtHash(accessToken, idTokenKey.privateKey),
      authTime: deviceGrant.authTime,
      acr,
      amr,
    }),
    privateKey: idTokenKey.privateKey,
    keyId: idTokenKey.keyId,
  });

  await stores.accessTokenStore.set(accessToken, {
    sub: deviceGrant.subject,
    clientId: deviceGrant.clientId,
    scope: deviceGrant.scope,
    expiresAt: issuedAt + config.accessTokenExpiresIn,
    // 承認のときに作ったグラント ID を引き継ぎ、そのグラントを失効させれば、このデバイス認可から発行したトークンがすべて失効するようにする。
    grantId: deviceGrant.grantId,
    iat: issuedAt,
    nbf: issuedAt,
    audience,
    issuer: config.issuer,
    jti: accessTokenPayload.jti,
  });

  // `scope` に `offline_access` があれば、リフレッシュトークンを発行する（OIDC Core 1.0 §11）。
  // `offline_access` がここまで残るのは、デバイス認可エンドポイントの方針の確認で、このクライアントがリフレッシュトークンを持てると判定されたときだけである。
  // エンドユーザーが通った承認画面が §11 の求める明示的な同意にあたるので、ここで確かめることはほかにない。
  const refreshToken = deviceGrant.scope.includes('offline_access')
    ? generateRandomString(32)
    : undefined;
  if (refreshToken) {
    await stores.refreshTokenStore.set(refreshToken, {
      subject: deviceGrant.subject,
      clientId: deviceGrant.clientId,
      scope: deviceGrant.scope,
      // 有効期限は、最初の発行から数えた絶対的な期間で決める（OAuth 2.1 §6.1）。
      // ローテーションでは `originalIssuedAt` を引き継ぐので、期限が後ろにずれることはない。
      expiresAt: issuedAt + config.refreshTokenAbsoluteLifetime,
      originalIssuedAt: issuedAt,
      used: false,
      grantId: deviceGrant.grantId,
      iat: issuedAt,
      issuer: config.issuer,
      audience,
      authTime: deviceGrant.authTime,
      // RFC 8628 には `nonce` パラメータがないので、再発行する ID トークンにも引き継ぐ `nonce` はない。
      nonce: undefined,
      acr,
      amr,
      azp: undefined,
    });
  }

  return noStoreJson({
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: config.accessTokenExpiresIn,
    id_token: idToken,
    scope: deviceGrant.scope.join(' '),
    refresh_token: refreshToken,
  });
}

/**
 * グラントタイプがデバイスコードならトークンで応答する。
 *
 * `grant_type` がデバイスコードの URN でなければ、何もせず `undefined` を返す。
 * トークンエンドポイントのルートハンドラは、この関数をクライアント認証の直後、`grant_type` の検証より前に呼ぶ。
 * `grant_type` の検証（core の `validateGrantTypeSupported()`）は `authorization_code` と `refresh_token` しか受け付けず、この URN を `unsupported_grant_type` で拒否するためである。
 *
 * デバイスコードのグラントなら `redeemDeviceCode()` で応答し、`DeviceAuthorizationError` は RFC 6749 §5.2 の形のエラーレスポンス（400）にして返す。
 * それ以外の例外は、そのまま投げ直す。
 *
 * @spec RFC 8628 §3.4
 * @spec RFC 8628 §3.5
 */
export async function dispatchDeviceCode(
  params: Record<string, string>,
  client: TokenClientInfo,
  keys: ProviderSigningKeys,
): Promise<Response | undefined> {
  if (params.grant_type !== DEVICE_CODE_GRANT_TYPE) return undefined;
  try {
    return await redeemDeviceCode(params, client, keys);
  } catch (error) {
    if (error instanceof DeviceAuthorizationError) {
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    throw error;
  }
}
