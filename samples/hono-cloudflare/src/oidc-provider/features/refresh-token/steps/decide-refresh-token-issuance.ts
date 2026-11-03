import {
  type TokenClientInfo,
  type ValidatedTokenRequest,
  clientAllowsRefreshTokenGrant,
} from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'decide-refresh-token-issuance',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'decide',
  label: 'リフレッシュトークンを発行するか決める',
  spec: 'OIDC Core 1.0 §11 / RFC 9700 §4.14',
  function: 'decideRefreshTokenIssuance',
  consumes: ['tokenClient', 'validatedRequest'],
  produces: ['refreshTokenDecision'],
  removable: false,
});

/** Whether, and how, a refresh token is issued with this response. */
export interface RefreshTokenDecision {
  /** The grant holds offline_access: the refresh token outlives the login session. */
  grantHasOfflineAccess: boolean;
  /** The login session an online refresh token is bound to (undefined: not bound). */
  boundSessionId: string | undefined;
  /** Whether a refresh token is minted at all. */
  issueRefreshToken: boolean;
}

/**
 * リフレッシュトークンを発行するかと、その種類を返す。
 *
 * 種類は、ログインセッションに結び付けるもの（オンライン）と、ログインセッションが終わっても使えるもの（`offline_access`）の二つである。
 * クライアントが `grant_types` に `refresh_token` を登録しているときに限り、次のどちらかが成り立てば発行する。
 * - グラントが `offline_access` を持つ。
 * - 設定の `onlineRefreshTokenEnabled` が true で、結び付けるセッションがある。
 *
 * @spec OIDC Core 1.0 §11
 * @spec RFC 9700 §4.14
 * @spec RFC 6749 §6
 */
export function decideRefreshTokenIssuance(
  c: any,
  tokenClient: TokenClientInfo,
  validatedRequest: ValidatedTokenRequest,
): RefreshTokenDecision {
  const config = c.get('config');

  // クライアントが `grant_types` に `refresh_token` を登録しているかを確かめ、登録していなければリフレッシュトークンを発行しない。
  // `grant_types` の既定値は `["authorization_code"]` である（RFC 7591 §2、OIDC Dynamic Client Registration 1.0 §2）。
  // 登録していないクライアントにリフレッシュトークンを渡しても、`grant_type=refresh_token` で使った時点で `validateClientGrantType()` が `unauthorized_client` で拒否する。
  // 一度も使えない長期の認証情報をクライアントに保存させるだけになるので、発行しない（RFC 9700 §4.14）。
  const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

  // グラントが `offline_access` を持つかを決める（RFC 6749 §6、OIDC Core 1.0 §11）。
  // リフレッシュでスコープを狭めたときは、このリクエストで発行するアクセストークンと ID トークンの権限を狭めるだけにし、リフレッシュトークンのローテーションを続けるかどうかとは切り離す。
  // ローテーションを続けるかは、元のグラントが `offline_access` を持っていたかで決める。
  // - `authorization_code` グラント: 今回許可したスコープに `offline_access` があるか。
  // - `refresh_token` グラント: 元のリフレッシュトークンのグラントが `offline_access` を持っていたか（`validatedRequest.hadOfflineAccess`）。
  //   狭めたスコープから `offline_access` を外しても、元のグラントの権限は失われないので、ローテーションを続ける。
  const grantHasOfflineAccess =
    clientAllowsRefreshGrant &&
    (validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.hadOfflineAccess
      : validatedRequest.scope.includes('offline_access'));

  // オンラインのリフレッシュトークンを結び付けるセッションを決め、`offline_access` を持つグラントでは結び付けない。
  // OIDC Core 1.0 §11 は、`offline_access` を「エンドユーザーがログインしていないときにも使えるリフレッシュトークン」と定義したうえで、リフレッシュトークンの用途がそれに限られないことも明示している（「認可サーバーは、ほかの状況でもリフレッシュトークンを発行してよい（MAY）」）。
  // この OP は、その「ほかの状況」をオンラインのリフレッシュトークンとして実装し、ログインセッションに結び付ける。
  // - `authorization_code` グラント: 認可コードが持つ `sessionId`（ログインしたときに作ったもの）。
  // - `refresh_token` グラント: 元のリフレッシュトークンの結び付きをそのまま引き継ぎ、ローテーションで外れないようにする。
  const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

  // 結び付けるセッションが分からなければ、オンラインのリフレッシュトークンは発行しない。
  // ブラウザのセッションを持たないグラント（デバイス認可グラント）がこれに当たる。
  // ログアウトしても使えなくならないリフレッシュトークンを渡さないよう、分からないときは発行しない側に倒す。
  const issueRefreshToken =
    clientAllowsRefreshGrant &&
    (grantHasOfflineAccess ||
      (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

  return { grantHasOfflineAccess, boundSessionId, issueRefreshToken };
}
