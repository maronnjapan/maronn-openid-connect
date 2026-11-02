/**
 * EXPERIMENTAL — Device Authorization Endpoint (RFC 8628 §3.1 / §3.2).
 *
 * Generated because the OP was created with `--enable device-authorization-grant`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a
 * breaking way between releases. Do not build production code on it without
 * pinning the version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the End-User types into /device on another
 * device's browser.
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is left to
 * the deployment layer (reverse proxy / platform). An in-process counter cannot
 * work across instances, so putting one here would give a false sense of
 * protection. The in-band defenses are the 20^8 user_code entropy, the short
 * TTL, and answering every failed match identically.
 */
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import {
  TokenError,
  extractClientCredentials,
  findUnregisteredClientScopes,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { clientResolver, config } from '../../_oidc-provider/provider';
import { tokenGrantsOf } from '../../_oidc-provider/feature';
import { features } from '../../_oidc-provider/features';
import { deviceAuthorizationStore } from '../../_oidc-provider/features/device-authorization-grant/store';
import {
  clientCors,
  corsPreflight,
  isFormUrlEncoded,
  noStoreJson,
  oauthError,
  uniqueParams,
  withCors,
} from '../../_oidc-provider/http';
import { findUnsupportedScopes } from '../../_oidc-provider/scopes';
import { deviceAuthorizationConfig } from '../../_oidc-provider/features/device-authorization-grant/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * デバイス認可リクエストに応答し、CORS ヘッダーを付ける。
 *
 * `POST /device_authorization` に、`deviceAuthorization()` が作るキャッシュ禁止の JSON（`device_code`、`user_code`、検証用の URI か、OAuth のエラーレスポンス）で応答する。
 * 応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await deviceAuthorization(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/device_authorization` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * リクエストを検証して保存し、JSON で応答する。
 *
 * デバイス認可リクエストを次の順に処理し、どこかで失敗すれば OAuth のエラーレスポンスを返す。
 * - ボディが `application/x-www-form-urlencoded` で、同じパラメータが繰り返されていないことを確かめる（`invalid_request`）。
 * - クライアントを認証する（失敗すると `TokenError` のステータス。`invalid_client` なら 401）。
 * - グラントの登録とスコープを検証し、許可できない `offline_access` を取り除く（`unauthorized_client`、`invalid_request`、`invalid_scope`）。
 * - デバイスコードとユーザーコードを作り、保留中のレコードを保存する。
 *
 * 成功すると、`device_code`、`user_code`、`verification_uri`、`verification_uri_complete`、`expires_in`、`interval` を 200 の JSON で返す。
 * それ以外の例外には、500 の `server_error` を返す。
 * RFC 8628 §3.2 にキャッシュの規則はないが、`device_code` はトークンの取得に使う秘密の値なので、エラーも含めたすべての応答で、トークンレスポンスと同じくキャッシュを禁じる（RFC 6749 §5.1、§5.2）。
 *
 * @spec RFC 8628 §3.1
 * @spec RFC 8628 §3.2
 * @spec RFC 6749 §5.1
 * @spec RFC 6749 §5.2
 */
async function deviceAuthorization(request: Request): Promise<Response> {
  // ボディが `application/x-www-form-urlencoded` でなければ拒否する（RFC 8628 §3.1 の MUST）。
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Device authorization requests must use application/x-www-form-urlencoded');
  }

  // 同じパラメータが繰り返されていれば拒否する（RFC 6749 §3.1 の MUST NOT）。
  const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated`);
  }

  try {
    // --- クライアント認証のパイプライン: トークンエンドポイントと同じ core の関数を同じ順に呼ぶ。
    // このエンドポイントにも、RFC 6749 §3.2.1 のクライアント認証の要件が当てはまる（RFC 8628 §3.1）。
    // パブリッククライアントは `client_id` だけを提示する。
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: request.headers.get('Authorization') ?? '',
    });
    const client = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      clientResolver,
    );
    validateClientAuthMethod(client, presentedCredentials);
    await verifyClientSecret(client, presentedCredentials.clientSecret);

    // --- デバイス認可のパイプライン: 以下の処理は、どれも `@maronn-openid-connect/experimental/device-authorization-grant` の独立した関数を RFC 8628 §3.1 の順に呼ぶ。
    // 呼び出しを消せばその検証を外せ、処理の間に独自の処理を入れることもできる。

    // クライアントがデバイス認可グラントを登録していることを確かめる（RFC 6749 §5.2）。
    validateDeviceGrantAllowed(client);

    // `scope` があり、`openid` を含むことを確かめる。
    // RFC 8628 §3.1 では `scope` を省略してよい（OPTIONAL）が、この OP はどこでも `scope` と `openid` を必須にしている（`/authorize` と同じ規則）。
    // そのため、`scope` のないリクエストは、RFC 8628 では正しくても拒否する。
    // これは意図して設けた、既知の制限である。
    const requestedScope = validateDeviceAuthorizationScope(params['scope']);

    // スコープの一覧（`client.scope`）を登録したクライアントが、一覧にないスコープを要求していれば拒否する（RFC 7591 §2）。
    // `/authorize` と同じ規則である。
    const unregisteredScopes = findUnregisteredClientScopes(requestedScope, client.scope);
    if (unregisteredScopes.length > 0) {
      throw new DeviceAuthorizationError(
        'invalid_scope',
        'Client is not registered for scope: ' + unregisteredScopes.join(' '),
      );
    }

    // 許可できない `offline_access` を取り除く（OIDC Core 1.0 §11）。
    // 許可できないのは、クライアントが `refresh_token` を登録していないときと、OP に `refresh_token` グラントがない（`refresh-token` 機能を生成していない）ときである。
    const scope = applyOfflineAccessPolicy(requestedScope, {
      client,
      refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
    });

    // OP が宣言していないスコープを、`/authorize` と同じように拒否する（RFC 6749 §3.3）。
    // `applyOfflineAccessPolicy()` の後で確かめるので、方針で取り除いた `offline_access` は `invalid_scope` にならず、無視されたままになる（OIDC Core 1.0 §11）。
    const unsupportedScopes = findUnsupportedScopes(scope);
    if (unsupportedScopes.length > 0) {
      throw new DeviceAuthorizationError(
        'invalid_scope',
        'Unsupported scope: ' + unsupportedScopes.join(' '),
      );
    }

    // RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
    // base-20 user_code, then store the pending record under both.
    const record = await createDeviceAuthorizationRecord({
      clientId: client.clientId,
      scope,
      store: deviceAuthorizationStore,
      expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
      interval: deviceAuthorizationConfig.pollInterval,
    });

    // Never log device_code or user_code: both are live credentials for the
    // lifetime of the record (RFC 8628 §5.1 / §5.2).

    return noStoreJson(buildDeviceAuthorizationResponse(record, config.issuer));
  } catch (error) {
    if (error instanceof DeviceAuthorizationError) {
      // RFC 6749 §5.2 shape. Authentication failures are core TokenErrors (401).
      return oauthError(error.code, error.errorDescription, error.statusCode);
    }
    if (error instanceof TokenError) {
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
