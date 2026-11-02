/**
 * EXPERIMENTAL — Backchannel Authentication Endpoint (CIBA Core 1.0, poll mode).
 *
 * Generated because the OP was created with `--enable ciba`. Backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The consumption device (a call-center console, a kiosk, a smart speaker
 * backend) POSTs here — back channel, client-authenticated — with a login_hint
 * naming the user, and receives an auth_req_id it polls the token endpoint
 * with. The user approves or denies on their own browser at /ciba.
 *
 * NOTE (CIBA §15): the login_hint is a user identifier and therefore PII. Never
 * log it, and never echo it in an error_description. Rate limiting is left to
 * the deployment layer (reverse proxy / platform); the in-band defenses are
 * mandatory client authentication, the fixed unknown_user_id wording, and the
 * per-subject pending-request cap (config.ts).
 */
import {
  BackchannelAuthenticationError,
  processBackchannelAuthenticationRequest,
  type CibaClientInfo,
} from '@maronn-openid-connect/experimental/ciba';
import {
  TokenError,
  extractClientCredentials,
  findUnregisteredClientScopes,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '@maronn-openid-connect/core';
import { cibaAuthenticationRequestStore } from '../../_oidc-provider/features/ciba/store';
import { clientResolver } from '../../_oidc-provider/provider';
import { resolveCibaUser } from '../../_oidc-provider/features/ciba/user';
import { tokenGrantsOf } from '../../_oidc-provider/feature';
import { features } from '../../_oidc-provider/features';
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
import { cibaConfig } from '../../_oidc-provider/features/ciba/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 認証リクエストに応答し、CORS ヘッダーを付ける。
 *
 * `POST /backchannel_authentication` に、`backchannelAuthentication()` が作るキャッシュ禁止の JSON（`/token` のポーリングに使う `auth_req_id` か、OAuth のエラーレスポンス）で応答する。
 * 応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await backchannelAuthentication(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/backchannel_authentication` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * リクエストを検証して保存し、JSON で応答する。
 *
 * CIBA の認証リクエストを次の順に処理し、どこかで失敗すれば OAuth のエラーレスポンスを返す。
 * - ボディが `application/x-www-form-urlencoded` で、同じパラメータが繰り返されていないことを確かめる（`invalid_request`）。
 * - クライアントを認証する（失敗すると `TokenError` のステータス。`invalid_client` なら 401）。
 * - OP が宣言していないスコープと、クライアントが登録していないスコープを拒否する（`invalid_scope`）。
 * - `processBackchannelAuthenticationRequest()` でリクエストを検証し、`login_hint` で示されたユーザー宛ての保留中のレコードを保存する（失敗すると 400）。
 *
 * 成功すると、`auth_req_id`、`expires_in`、`interval` を 200 の JSON で返す。
 * それ以外の例外には、500 の `server_error` を返す。
 * `auth_req_id` はトークンの取得に使う秘密の値なので、エラーも含めたすべての応答で、トークンレスポンスと同じくキャッシュを禁じる（RFC 6749 §5.1、§5.2）。
 *
 * @spec CIBA Core 1.0 §7
 * @spec RFC 6749 §5.1
 * @spec RFC 6749 §5.2
 */
async function backchannelAuthentication(request: Request): Promise<Response> {
  // ボディが `application/x-www-form-urlencoded` でなければ拒否する（CIBA §7.1 の MUST）。
  if (!isFormUrlEncoded(request)) {
    return oauthError('invalid_request', 'Backchannel authentication requests must use application/x-www-form-urlencoded');
  }

  // 同じパラメータが繰り返されていれば拒否する（RFC 6749 §3.1 の MUST NOT）。
  const { params, duplicateKey } = uniqueParams(new URLSearchParams(await request.text()));
  if (duplicateKey !== undefined) {
    return oauthError('invalid_request', `Parameter "${sanitizeErrorDescription(duplicateKey)}" must not be repeated`);
  }

  try {
    // --- クライアント認証のパイプライン: トークンエンドポイントと同じ core の関数を同じ順に呼ぶ。
    // クライアントは、`client_id` に登録した認証方式で認証しなければならない（CIBA §7.1 の MUST）。
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

    // OP が宣言していないスコープを、`/authorize` と同じ許可リスト（`scopes.ts`）で拒否する（RFC 6749 §3.3）。
    // 未知のスコープを含むリクエストをストアに保存しないよう、experimental パッケージの処理より前に確かめる。
    // `offline_access` は判定から外す。
    // experimental パッケージは許可できない `offline_access` を独自の方針で無視する（OIDC Core 1.0 §11）ので、ここで拒否すると、無視されるはずの値でリクエスト全体が失敗してしまう。
    const unsupportedScopes = findUnsupportedScopes(
      (params['scope'] ?? '')
        .split(' ')
        .filter((scope) => scope.length > 0 && scope !== 'offline_access'),
    );
    if (unsupportedScopes.length > 0) {
      throw new BackchannelAuthenticationError(
        'invalid_scope',
        'Unsupported scope: ' + unsupportedScopes.join(' '),
      );
    }

    // スコープの一覧（`client.scope`）を登録したクライアントが、一覧にないスコープを要求していれば拒否する（RFC 7591 §2）。
    // `/authorize` と同じ規則である。
    const unregisteredScopes = findUnregisteredClientScopes(
      (params['scope'] ?? '').split(' ').filter((scope) => scope.length > 0),
      client.scope,
    );
    if (unregisteredScopes.length > 0) {
      throw new BackchannelAuthenticationError(
        'invalid_scope',
        'Client is not registered for scope: ' + unregisteredScopes.join(' '),
      );
    }

    // --- バックチャネル認証のパイプライン: experimental パッケージがリクエストを検証し、保留中のレコードを保存する。
    // 検証は CIBA §7.1 の順に進む。
    // クライアント（パブリッククライアントでないこと、CIBA のグラントタイプの登録、トークンの配信モード）、`request` パラメータがないこと、ヒントがちょうど 1 つであること、`scope`、`binding_message`、`requested_expiry`、`login_hint` からのユーザーの特定（`_oidc-provider/features/ciba/user.ts` の `resolveCibaUser()`）、ユーザーごとの保留中のリクエスト数の上限の順に確かめ、最後にレコードを作る。
    const response = await processBackchannelAuthenticationRequest({
      params,
      client: client as CibaClientInfo,
      store: cibaAuthenticationRequestStore,
      config: cibaConfig,
      refreshTokenFeatureEnabled: tokenGrantsOf(features).includes('refresh_token'),
      resolveUser: resolveCibaUser,
    });

    // `auth_req_id`（有効な間はトークンの取得に使える値）と `login_hint`（個人情報。CIBA §15）は、ログに出さない。

    return noStoreJson(response);
  } catch (error) {
    if (error instanceof BackchannelAuthenticationError) {
      // experimental パッケージが拒否したリクエストを、CIBA §13 と RFC 6749 §5.2 の形のエラーレスポンス（400）で返す。
      // クライアント認証の失敗は core の `TokenError`（`invalid_client` なら 401）なので、次の分岐で返す。
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
