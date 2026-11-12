/**
 * client_credentials グラント（RFC 6749 §4.4 / OAuth 2.1 §4.2）のステップ関数。
 *
 * クライアントが自分自身の権限でアクセストークンを得るグラントで、エンドユーザーは関わらない。
 * そのため、認可コードやリフレッシュトークンのグラントと違い、ここで検証するのはクライアントの登録内容だけである。
 *
 * - グラントを使ってよいクライアントか（{@link validateClientCredentialsGrantAllowed}、{@link validateClientCredentialsConfidentialClient}）
 * - 発行するスコープ（{@link resolveClientCredentialsScope}）
 * - 発行先のリソース（{@link resolveClientCredentialsAudience}）
 *
 * クライアント認証そのものは、ほかのグラントと同じくトークンエンドポイントが先に済ませる。
 */
import { isPublicTokenClient } from './client-auth.js';
import { clientAllowsGrantType } from './client-grant-types.js';
import { findUnregisteredClientScopes, parseScope } from './scope.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import type { TokenClientInfo } from './token-request.js';

/** client_credentials グラントの `grant_type` の値（RFC 6749 §4.4.2）。 */
export const CLIENT_CREDENTIALS_GRANT_TYPE = 'client_credentials';

/**
 * client_credentials グラントでは発行しないスコープ。
 *
 * - `openid`: エンドユーザーの認証を表すスコープである（OIDC Core 1.0 §3.1.2.1）。
 *   エンドユーザーが関わらないグラントで発行すると、`sub` がクライアントを指すトークンが UserInfo エンドポイントに届いてしまう。
 * - `offline_access`: リフレッシュトークンを求めるスコープである（OIDC Core 1.0 §11）。
 *   このグラントはリフレッシュトークンを返さない（RFC 6749 §4.4.3）。
 */
export const CLIENT_CREDENTIALS_FORBIDDEN_SCOPES: readonly string[] = ['openid', 'offline_access'];

/**
 * 検証済みの client_credentials グラントのリクエスト。
 */
export interface ValidatedClientCredentialsRequest {
  grantType: 'client_credentials';
  clientId: string;
  /**
   * アクセストークンの `sub` に入れる値。
   * リソースオーナーが関わらないグラントでは、クライアントを示す識別子にする（RFC 9068 §2.2）。
   */
  subject: string;
  /** 発行するスコープ。クライアントがスコープを登録しておらず、要求もしなかったときは空の配列。 */
  scope: string[];
  /** 要求されたオーディエンス。`audience` パラメータがなければ `undefined`。 */
  audience?: string[];
}

/**
 * client_credentials グラントのトークンレスポンスのボディ（RFC 6749 §4.4.3 / §5.1）。
 */
export interface ClientCredentialsTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  /** 発行したスコープ（空白区切り）。発行したスコープがなければ省く。 */
  scope?: string;
}

/**
 * クライアントが `client_credentials` を登録していなければ拒否する。
 *
 * クライアントの `grantTypes` に `client_credentials` がなければ、`TokenError`（`unauthorized_client`）を投げる（RFC 6749 §5.2）。
 * `grantTypes` を登録していないクライアントの既定値は `["authorization_code"]` なので（RFC 7591 §2）、このグラントを使うクライアントは明示して登録する。
 *
 * @spec RFC 6749 §5.2
 * @spec RFC 7591 §2
 * @throws {TokenError} `unauthorized_client`: クライアントが `client_credentials` を登録していないとき
 */
export function validateClientCredentialsGrantAllowed(
  client: Pick<TokenClientInfo, 'grantTypes'>,
): void {
  if (!clientAllowsGrantType(client, CLIENT_CREDENTIALS_GRANT_TYPE)) {
    throw new TokenError(
      TokenErrorCode.UnauthorizedClient,
      `Client is not authorized to use grant_type: ${CLIENT_CREDENTIALS_GRANT_TYPE}`,
    );
  }
}

/**
 * パブリッククライアントなら拒否する。
 *
 * client_credentials グラントは、コンフィデンシャルクライアントだけが使える（RFC 6749 §4.4 の MUST、OAuth 2.1 §4.2）。
 * 認証方式に `none` を登録したクライアント（パブリッククライアント）は `client_id` を名乗るだけで認証していないので、`TokenError`（`unauthorized_client`）を投げる。
 * `grantTypes` に `client_credentials` を誤って登録したパブリッククライアントにも、トークンを発行しない。
 *
 * @spec RFC 6749 §4.4
 * @spec OAuth 2.1 §4.2
 * @throws {TokenError} `unauthorized_client`: パブリッククライアントのとき
 */
export function validateClientCredentialsConfidentialClient(
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethods'>,
): void {
  if (isPublicTokenClient(client)) {
    throw new TokenError(
      TokenErrorCode.UnauthorizedClient,
      'The client_credentials grant is only available to confidential clients',
    );
  }
}

/**
 * 発行できないスコープが要求されたら拒否する。
 *
 * `requestedScopes` に `openid` か `offline_access`（{@link CLIENT_CREDENTIALS_FORBIDDEN_SCOPES}）があれば、その値をエラーの説明に並べて `TokenError`（`invalid_scope`）を投げる。
 * どちらもエンドユーザーの認可を前提にしたスコープで、エンドユーザーが関わらないこのグラントでは発行できない。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §11
 * @spec RFC 6749 §4.4.3
 * @throws {TokenError} `invalid_scope`: `openid` か `offline_access` を含むとき
 */
export function validateClientCredentialsScopeAllowed(requestedScopes: readonly string[]): void {
  const forbidden = requestedScopes.filter((scope) => CLIENT_CREDENTIALS_FORBIDDEN_SCOPES.includes(scope));
  if (forbidden.length > 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      `Scope is not available for the client_credentials grant: ${forbidden.join(' ')}`,
    );
  }
}

/**
 * クライアントに登録されていないスコープが要求されたら拒否する。
 *
 * `requestedScopes` のうち、クライアントの登録メタデータ `scope`（RFC 7591 §2）にない値があれば、その値をエラーの説明に並べて `TokenError`（`invalid_scope`）を投げる。
 * スコープを登録していない（`registeredScope` が `undefined`）クライアントには、どのスコープも発行しない。
 *
 * 認可エンドポイントでは、スコープを登録していないクライアントを制限しない（{@link validateClientScope}）。
 * そこではエンドユーザーが同意画面で要求を確かめるが、このグラントにはその確認がないので、クライアントごとの登録だけを根拠にする。
 *
 * @spec RFC 7591 §2
 * @spec RFC 6749 §4.4.2
 * @throws {TokenError} `invalid_scope`: クライアントに登録されていない値を含むとき
 */
export function validateClientCredentialsScopeRegistered(
  requestedScopes: readonly string[],
  registeredScope: readonly string[] | undefined,
): void {
  const unregistered = findUnregisteredClientScopes(requestedScopes, registeredScope ?? []);
  if (unregistered.length > 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      `Client is not registered for scope: ${unregistered.join(' ')}`,
    );
  }
}

/**
 * 発行するスコープを決めて返す。
 *
 * `requestedScope`（リクエストの `scope` パラメータ）があれば、半角空白で分けて重複を取り除き、次の順に確かめてから返す。
 * - 値が一つもない（空文字列や空白だけ）なら `invalid_scope`。
 * - `openid` か `offline_access` を含むなら `invalid_scope`（{@link validateClientCredentialsScopeAllowed}）。
 * - クライアントに登録されていない値を含むなら `invalid_scope`（{@link validateClientCredentialsScopeRegistered}）。
 *
 * `scope` パラメータがなければ、あらかじめ決めた既定値として、クライアントに登録されたスコープから `openid` と `offline_access` を除いたものを返す（RFC 6749 §3.3）。
 * スコープを登録していないクライアントには、空の配列を返す。
 *
 * @spec RFC 6749 §4.4.2
 * @spec RFC 6749 §3.3
 * @spec RFC 7591 §2
 * @throws {TokenError} `invalid_scope`: 要求されたスコープが空のとき、発行できない値を含むとき、またはクライアントに登録されていない値を含むとき
 */
export function resolveClientCredentialsScope(
  requestedScope: string | undefined,
  client: Pick<TokenClientInfo, 'scope'>,
): string[] {
  if (requestedScope === undefined) {
    return (client.scope ?? []).filter((scope) => !CLIENT_CREDENTIALS_FORBIDDEN_SCOPES.includes(scope));
  }

  const requestedScopes = parseScope(requestedScope);
  if (requestedScopes.length === 0) {
    throw new TokenError(
      TokenErrorCode.InvalidScope,
      'Requested scope must not be empty',
    );
  }
  validateClientCredentialsScopeAllowed(requestedScopes);
  validateClientCredentialsScopeRegistered(requestedScopes, client.scope);

  return requestedScopes;
}

/**
 * 要求されたオーディエンスを検証して返す。
 *
 * `requestedAudience`（リクエストの `audience` パラメータ）がなければ `undefined` を返し、呼び出し側は既定の `aud` でトークンを発行する。
 * あれば半角空白で分けて重複を取り除き、すべての値が `allowedAudiences`（この認可サーバーがこのグラントで発行先にしてよいリソースの一覧）にあることを確かめてから返す。
 * 値が一つもないとき（空文字列や空白だけのとき）と、一覧にない値を含むときは、`TokenError`（`invalid_target`）を投げる（RFC 8707 §2）。
 *
 * `allowedAudiences` が空なら、`audience` を指定したリクエストをすべて拒否する。
 * エンドユーザーの同意がないグラントで、クライアントが名乗っただけのリソースを `aud` に入れないためである（RFC 9068 §3 は、リソースサーバーが `aud` で自分宛てのトークンかを確かめることを求める）。
 *
 * @spec RFC 8707 §2
 * @spec RFC 9068 §3
 * @throws {TokenError} `invalid_target`: 要求されたオーディエンスが空のとき、または許可されていない値を含むとき
 */
export function resolveClientCredentialsAudience(
  requestedAudience: string | undefined,
  allowedAudiences: readonly string[],
): string[] | undefined {
  if (requestedAudience === undefined) {
    return undefined;
  }

  const requested = [...new Set(requestedAudience.split(' ').filter((value) => value.length > 0))];
  if (requested.length === 0) {
    throw new TokenError(
      TokenErrorCode.InvalidTarget,
      'Requested audience must not be empty',
    );
  }
  const notAllowed = requested.filter((value) => !allowedAudiences.includes(value));
  if (notAllowed.length > 0) {
    throw new TokenError(
      TokenErrorCode.InvalidTarget,
      `Requested audience is not allowed: ${notAllowed.join(' ')}`,
    );
  }

  return requested;
}

/**
 * 検証済みの client_credentials グラントのリクエストを返す。
 *
 * それまでのステップの結果から、`grantType` が `client_credentials` のリクエストを組み立てる。
 * クライアント ID とサブジェクトには、どちらも認証したクライアントの ID を入れる。
 * リソースオーナーが関わらないグラントのアクセストークンでは、`sub` をクライアントを示す値にするためである（RFC 9068 §2.2）。
 *
 * クライアントの ID とエンドユーザーのサブジェクトが同じ値になりうる構成では、リソースサーバーが両者を取り違えないように、呼び出し側で名前空間を分ける（RFC 9068 §5）。
 *
 * @spec RFC 9068 §2.2
 * @spec RFC 9068 §5
 */
export function buildValidatedClientCredentialsRequest(
  authenticatedClientId: string,
  scope: string[],
  audience: string[] | undefined,
): ValidatedClientCredentialsRequest {
  return {
    grantType: 'client_credentials',
    clientId: authenticatedClientId,
    subject: authenticatedClientId,
    scope,
    audience,
  };
}

/**
 * client_credentials グラントのトークンレスポンスのボディを返す。
 *
 * `access_token`、`token_type`（`Bearer`）、`expires_in` を入れ、発行したスコープがあれば `scope`（空白区切り）も入れる。
 * リフレッシュトークンは入れない（RFC 6749 §4.4.3 の SHOULD NOT）。
 * クライアントは同じ認証情報でいつでも新しいアクセストークンを得られるので、リフレッシュトークンは要らない。
 * エンドユーザーの認証を表す ID トークンも入れない。
 *
 * @spec RFC 6749 §4.4.3
 * @spec RFC 6749 §5.1
 */
export function buildClientCredentialsTokenResponse(input: {
  accessToken: string;
  expiresIn: number;
  scope: readonly string[];
}): ClientCredentialsTokenResponse {
  return {
    access_token: input.accessToken,
    token_type: 'Bearer',
    expires_in: input.expiresIn,
    ...(input.scope.length > 0 ? { scope: input.scope.join(' ') } : {}),
  };
}
