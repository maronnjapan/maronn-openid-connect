import { TokenError, TokenErrorCode } from './token-error.js';
import { clientAllowsGrantType } from './client-grant-types.js';

/**
 * トークンエンドポイントへの生パラメータ（バリデーション前）
 *
 * application/x-www-form-urlencoded 形式のリクエストボディから取得した
 * 生の文字列マップを表す。grant_type は仕様上必須だが、
 * 「バリデーション前」のため型上は optional とし、
 * 欠損の検出は {@link validateGrantTypeSupported} で行う。
 */
export interface TokenRequestParams {
  grant_type: string;
  code?: string;
  redirect_uri?: string;
  // PKCE
  code_verifier?: string;
  // client_secret_post の場合に使用
  client_id?: string;
  client_secret?: string;
  // refresh_token grant
  refresh_token?: string;
  // refresh_token grant: 要求するスコープ（スペース区切り）
  scope?: string;
}

/**
 * トークンエンドポイントで使用するクライアント情報
 */
export interface TokenClientInfo {
  clientId: string;
  /**
   * クライアントシークレット。
   * RFC 6749 §2.1 / §3.2.1: public client（`tokenEndpointAuthMethods: ['none']`）は
   * シークレットを持たないため optional。confidential client では必須（未設定なら認証は必ず失敗する）。
   */
  clientSecret?: string;
  /**
   * client_secret を平文で持たないときに登録する、client_secret の SHA-256 ハッシュ
   * （base64url、パディング無し）。{@link hashClientSecret} で作る。
   * 設定すると {@link verifyClientSecret} は clientSecret を使わず、この値と照合する。
   *
   * SHA-256 は速いハッシュなので、短い値や推測できる値は総当たりで元に戻される。
   * client_secret は CSPRNG で作った十分長い値（例: 32 バイト）にすること。
   */
  clientSecretHash?: string;
  /**
   * このクライアントが使用してよい grant_type の一覧。
   * OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 省略時の既定は
   * `["authorization_code"]`（refresh_token は不許可）。
   * 登録外の grant_type は RFC 6749 §5.2 の `unauthorized_client` で拒否される。
   */
  grantTypes?: string[];
  /**
   * このクライアントが要求してよい scope の一覧（RFC 7591 §2 の `scope`）。省略時は制限しない。
   * {@link ClientInfo.scope} と同じ値で、Device Authorization Grant や CIBA のように
   * Token Endpoint 側のクライアント情報で scope を受け付ける経路が照合に使う。
   */
  scope?: string[];
  /**
   * このクライアントが Token Endpoint などで使ってよいクライアント認証方式
   * （RFC 7591 §2 の `token_endpoint_auth_method` の値）。
   * 実際に使われた方式がこの一覧に無ければ `invalid_client` で拒否する（認証方式ダウングレードの防止）。
   *
   * - 省略すると RFC 7591 §2 の既定どおり `['client_secret_basic']`
   * - `['none']` は public client。`none` はほかの方式と並べられない
   * - `client_secret_basic` と `client_secret_post` のように、1 つのクライアントに複数の方式を
   *   許すときは並べる。シークレットはどの方式でも同じ `clientSecret`（`clientSecretHash`）と照合する
   * - 空の一覧はどの方式も許さない
   */
  tokenEndpointAuthMethods?: readonly ClientAuthMethod[];
}

/**
 * クライアントに登録できるクライアント認証方式（RFC 7591 §2 の `token_endpoint_auth_method`）。
 * `none` はクライアント認証をしない public client を表す。
 */
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * クライアント情報を解決するインターフェース
 */
export interface TokenClientResolver {
  /**
   * 登録済みのクライアントを返す（なければ `null`）。
   *
   * `clientId` で登録済みのクライアントを探し、クライアント認証に使う情報（シークレットのハッシュ、登録した認証方式など）を返す。
   */
  findClient(clientId: string): Promise<TokenClientInfo | null>;
}

/**
 * 認可コードの情報
 */
export interface AuthorizationCodeInfo {
  code: string;
  /**
   * 認可付与の一意識別子。同じ grantId を持つアクセストークン・リフレッシュトークンが
   * 1セットの認可付与に紐づく。コード再利用検知時に `revokeTokensByGrantId` の引数となる。
   */
  grantId: string;
  clientId: string;
  redirectUri: string;
  /**
   * 認可リクエストで redirect_uri が明示されていたか。
   * OIDC Core 1.0 Section 3.1.3.2: 明示されていた場合 Token リクエストでも MUST 一致 (=必須化)。
   * 認可リクエストで省略され (登録 1 件で省略可) コードが発行された場合は false。
   */
  redirectUriExplicit: boolean;
  scope: string[];
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  expiresAt: number;
  used: boolean;
  nonce?: string;
  audience?: string[];
  /**
   * OIDC Core 1.0 §3.1.2.1: requested `acr_values` preserved from authorization so it can be
   * passed to the AcrResolver as `requestedAcrValues` at the token endpoint.
   */
  acrValues?: string;
  /** OIDC Core 1.0 §5.5: claims request preserved from authorization for ID Token issuance. */
  claims?: import('./userinfo.js').ClaimsParameter;
  /**
   * この認可コードを発行した OP 認証セッションの識別子。
   * online refresh token（`offline_access` 無しで発行する Refresh Token）を
   * そのセッションへ束縛するために引き継ぐ。セッションを持たない経路
   * （device authorization grant など）では undefined。
   */
  sessionId?: string;
}

/**
 * 認可コードを解決するインターフェース
 */
export interface AuthorizationCodeResolver {
  /**
   * 認可コードの保存済みの情報を返す（なければ `null`）。
   *
   * 返す情報には、発行先のクライアント、`redirect_uri`、PKCE の値、使用済みかどうかなどが含まれる。
   * 使用済みのコードも、少なくとも認可コードの元の有効期間のあいだは返し続ける（{@link AuthorizationCodeResolver.revokeAuthorizationCode}）。
   */
  findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null>;
  /**
   * 認可コードを使用済みにする。
   *
   * **実装は、レコードを削除せず、`used` を `true` に更新しなければならない**（できればアトミックに）。
   * `findAuthorizationCode` は、少なくとも認可コードの元の有効期間のあいだは、使用済みのレコードを返し続ける。
   * 有効期間を過ぎた後にレコードを消すのは構わない。
   *
   * レコードを削除せずに使用済みとして残すのは、使用済みのコードが再び提示されたことを検知するためである（OAuth 2.1 §4.1.2、RFC 9700 §4.13）。
   * 認可コードが再び提示されたら、漏洩した可能性があるので、同じグラント ID で発行したトークンをすべて失効させたい（`revokeTokensByGrantId`）。
   * この失効は、再び提示されたコードを「存在するが使用済み」と判定できたときにしか行えない。
   * レコードを削除する実装では、再提示は「見つからない」として `invalid_grant` で拒否されるだけで `revokeTokensByGrantId` は呼ばれず、漏洩したコードで発行したトークンが有効なまま残る（SHOULD に反する）。
   * 生成された OP では、`store.ts` の `consume()`（`used` の更新）を使い、`delete()`（レコードの削除）は使わない。
   */
  revokeAuthorizationCode(code: string): Promise<void>;
  /**
   * グラント ID が同じトークンをすべて失効させる。
   *
   * 認可コードの再利用を検知したときに、同じグラント ID のアクセストークンとリフレッシュトークンを失効させるために呼ぶ。
   * 認可サーバーは、再利用されたコードをもとに発行済みのトークンを失効させるべきである（SHOULD、OAuth 2.1 §4.1.2）。
   * このメソッドがなければ、再利用されたコードは `invalid_grant` で拒否されるが、発行済みのトークンは失効しない。
   */
  revokeTokensByGrantId?(grantId: string): Promise<void>;
}

/**
 * リフレッシュトークンの情報
 * OAuth 2.1 Section 4.3
 *
 * iat / issuer は RFC 7662 (Token Introspection) のレスポンスに含めるため。
 * いずれも optional で、未設定の場合はイントロスペクションから省略される。
 *
 * authTime / nonce / acr / amr / azp は OIDC Core 1.0 Section 12.1 で
 * refresh_token grant で再発行される ID Token に「初回認証時と同じ値」を保持する
 * SHOULD/MUST が課されるため、初回発行時に保存し refresh 時に引き継ぐ。
 */
export interface RefreshTokenInfo {
  subject: string;
  clientId: string;
  scope: string[];
  expiresAt: number;
  used: boolean;
  /**
   * 認可付与の一意識別子。元の認可コードと同じ grantId を引き継ぐことで、
   * 認可コード再利用検知時にローテーション後の refresh token も失効できる。
   */
  grantId: string;
  /** 発行時刻（Unix epoch 秒）。RFC 7662 の iat に対応 */
  iat?: number;
  /**
   * 初回発行時刻（Unix epoch 秒）。
   * OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効させる。
   * ローテーション時は元 RT の値をそのまま引き継ぎ、初回発行時（authorization_code grant）は
   * その時点の発行時刻を設定する。expiresAt は originalIssuedAt + absolute lifetime で決まる。
   */
  originalIssuedAt: number;
  /** 発行 OP の issuer URL。RFC 7662 の iss に対応 */
  issuer?: string;
  /**
   * この RT が直近にトークン化された時刻（Unix epoch 秒、任意）。
   * アイドル（非活動）タイムアウト判定に使う。ローテーション時に「今」へ更新する（スライディング）。
   * `originalIssuedAt`（絶対寿命の基準）とは別物で据え置き。未設定の場合や
   * `refreshTokenIdleTimeoutSeconds` 未指定時はアイドル判定をスキップする。
   */
  lastUsedAt?: number;
  /**
   * 認可時に決定されたアクセストークンの audience。
   * Refresh Token grant でもローテーション後のアクセストークンに同じ aud を保持する。
   * 拡大も欠損も許容しない。
   */
  audience?: string[];
  /**
   * 初回認証時刻（Unix epoch 秒）。
   * OIDC Core 1.0 Section 12.1: refresh で発行する ID Token の auth_time は初回認証時と同じ値。
   */
  authTime: number;
  /**
   * 初回認可リクエストの nonce。
   * 注: OIDC Core 1.0 §12.2 が列挙する refresh 再発行 ID Token の保持クレームに nonce は
   * 含まれない（§12.1 にも MUST 根拠は無い）。nonce は Authentication Request ↔ ID Token の
   * ワンタイム束縛（§2）であり、認可リクエストの無い refresh では保持してもリプレイ防止に
   * 寄与しない。生成 OP は既定で refresh 再発行 ID Token に nonce を出力しない。引き継ぎ
   * フィールド自体は将来用途のため残すが、ID Token への出力はしない。
   */
  nonce?: string;
  /**
   * 初回認証の Authentication Context Class Reference。
   * OIDC Core 1.0 Section 12.1 SHOULD: refresh の ID Token も同じ acr を保持。
   * refresh で発行するアクセストークンの acr（RFC 9068 §2.2.1）にも同じ値を使う。
   * 初回の発行で acr を決めなかった（要求も AcrResolver も無かった）場合は undefined。
   */
  acr?: string;
  /**
   * 初回認証の Authentication Methods References。
   * OIDC Core 1.0 Section 12.1 SHOULD: refresh の ID Token も同じ amr を保持。
   * 初回の発行で amr を決めなかった場合は undefined。
   */
  amr?: string[];
  /**
   * Authorized Party。multiple-audience の場合に必須 (OIDC Core 1.0 Section 2)。
   * 通常は client_id と同じ。refresh 時にも同じ値を保持する。
   */
  azp?: string;
  /**
   * この Refresh Token を束縛している OP 認証セッションの識別子。
   *
   * - **設定あり = online refresh token**: End-User がログインしている間だけ使える。
   *   {@link validateRefreshTokenSession} が毎回セッションの生存を確認し、
   *   終了していれば `invalid_grant` で拒否する。rotation では同じ値を引き継ぐ。
   * - **未設定 = offline refresh token**: OIDC Core 1.0 §11 の `offline_access` が
   *   付与された grant。End-User が居なくなった後も使える。
   */
  sessionId?: string;
}

/**
 * リフレッシュトークンを解決するインターフェース
 */
export interface RefreshTokenResolver {
  /**
   * リフレッシュトークンの情報を返す（なければ `null`）。
   *
   * 返す情報には、発行先のクライアント、スコープ、有効期限、使用済みかどうかなどが含まれる。
   * 使用済みのトークンも、少なくとも最初の発行から数える有効期間のあいだは返し続ける（{@link RefreshTokenResolver.revokeRefreshToken}）。
   */
  resolve(token: string): Promise<RefreshTokenInfo | null>;
  /**
   * リフレッシュトークンを使用済みにする。
   *
   * **実装は、レコードを削除せず、`used` を `true` に更新しなければならない**（できればアトミックに）。
   * `resolve` は、少なくともリフレッシュトークンの最初の発行から数える有効期間のあいだは、使用済みのレコードを返し続ける。
   * 有効期間を過ぎた後にレコードを消すのは構わない。
   *
   * レコードを削除せずに使用済みとして残すのは、ローテーション済みの古いリフレッシュトークンが再び提示されたことを検知するためである（OAuth 2.1 §4.3.1、RFC 9700 §4.14）。
   * 古いトークンが再び提示されたら、同じグラント ID のトークンをすべて失効させたい（`revokeTokensByGrantId`）。
   * この失効は、再び提示されたトークンを「存在するが使用済み」と判定できたときにしか行えない。
   * レコードを削除する実装では、再提示は「見つからない」として `invalid_grant` で拒否されるだけで `revokeTokensByGrantId` は呼ばれず、漏洩したトークンからローテーションで発行したトークンが有効なまま残る（SHOULD に反する）。
   */
  revokeRefreshToken(token: string): Promise<void>;
  /**
   * グラント ID が同じトークンをすべて失効させる。
   *
   * リフレッシュトークンの再利用を検知したときに、同じグラント ID のアクセストークンとリフレッシュトークンを失効させるために呼ぶ。
   * 認可サーバーは、そのリフレッシュトークンと、それをもとに発行したすべてのアクセストークンを失効させるべきである（SHOULD、OAuth 2.1 §4.3.1）。
   * このメソッドがなければ、再利用されたリフレッシュトークンは `invalid_grant` で拒否されるが、同じグラントで発行済みのほかのトークンは失効しない。
   */
  revokeTokensByGrantId?(grantId: string): Promise<void>;
}

/**
 * OP が Token Endpoint で提供する grant_type の既定値。
 * OAuth 2.1 の authorization code flow と refresh token grant のみを実装している。
 */
const DEFAULT_SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/**
 * バリデーション済みの authorization_code グラントリクエスト
 */
export interface ValidatedAuthorizationCodeRequest {
  grantType: 'authorization_code';
  clientId: string;
  code: string;
  /** 認可付与の一意識別子。発行するアクセストークン・リフレッシュトークンの metadata に保存し、コード再利用時の失効に使う */
  grantId: string;
  redirectUri: string;
  scope: string[];
  nonce?: string;
  audience?: string[];
  /**
   * OIDC Core 1.0 §3.1.2.1: requested `acr_values` from the authorization step.
   * 呼び出し側はこれを `resolveAcrAmr` の `requestedAcrValues` に渡し、AcrResolver が
   * 要求された acr を満たせるようにする。
   */
  acrValues?: string;
  /** OIDC Core 1.0 §5.5: claims request from the authorization step. */
  claims?: import('./userinfo.js').ClaimsParameter;
  /**
   * 認可コードを発行した OP 認証セッションの識別子。
   * 呼び出し側はこれを online refresh token の {@link RefreshTokenInfo.sessionId} に渡す。
   */
  sessionId?: string;
  codeVerified: boolean;
}

/**
 * バリデーション済みの refresh_token グラントリクエスト
 * OAuth 2.1 Section 4.3
 *
 * authTime / nonce / acr / amr / azp は OIDC Core 1.0 Section 12.1 で
 * refresh の ID Token に初回認証時と同じ値を保持するため引き継ぐ。
 */
export interface ValidatedRefreshTokenRequest {
  grantType: 'refresh_token';
  clientId: string;
  subject: string;
  scope: string[];
  /** 元の認可コードから引き継いだ grantId。新発行する access/refresh token に同じ値を保存する */
  grantId: string;
  /**
   * 元のアクセストークンに設定された audience。
   * 呼び出し側はこの値をそのまま新アクセストークンの aud に渡す。
   */
  audience?: string[];
  /** 初回認証時刻 (OIDC Core 1.0 §12.1: refresh ID Token の auth_time に使う) */
  authTime: number;
  /** 初回認可リクエストの nonce (OIDC Core 1.0 §12.1: 同じ値を保持 MUST) */
  nonce?: string;
  /** 初回認証の acr (OIDC Core 1.0 §12.1 SHOULD) */
  acr?: string;
  /** 初回認証の amr (OIDC Core 1.0 §12.1 SHOULD) */
  amr?: string[];
  /** 初回認可時の azp。multiple-audience 時に必要 */
  azp?: string;
  /**
   * 元 refresh token の初回発行時刻（Unix epoch 秒）。
   * OAuth 2.1 §6.1: ローテーション後の RT に同じ originalIssuedAt を引き継ぎ、
   * absolute lifetime を初回発行時刻から計算するため呼び出し側へ渡す。
   */
  originalIssuedAt: number;
  /**
   * 元 refresh token の付与スコープに offline_access が含まれていたか。
   * RFC 6749 §6: refresh 時の scope 縮小は当該リクエストの access token / ID Token の
   * 権限縮小として扱い、refresh token rotation の可否とは切り離す。OIDC Core 1.0 §11 の
   * offline_access は grant 単位の permission であり、縮小後 scope（`scope` フィールド）から
   * offline_access を落としても元 grant の権限は失われない。呼び出し側はこのフラグで
   * rotation 可否を判定し、縮小後 scope に offline_access が無くても rotation を継続する。
   */
  hadOfflineAccess: boolean;
  /**
   * 元 refresh token が束縛していた OP 認証セッションの識別子（online refresh token のみ）。
   * 呼び出し側は rotation 後の RT にも同じ値を保存し、束縛を維持する。
   * offline refresh token では undefined。
   */
  sessionId?: string;
}

/**
 * バリデーション済みのトークンリクエスト（判別共用体）
 */
export type ValidatedTokenRequest = ValidatedAuthorizationCodeRequest | ValidatedRefreshTokenRequest;

/**
 * `grant_type` が OP の対応する値か検証して返す。
 *
 * `grant_type` がないか空文字列なら、`TokenError`（`invalid_request`）を投げる。
 * `authorization_code` と `refresh_token` 以外の値と、`supportedGrantTypes` にない値には、`TokenError`（`unsupported_grant_type`）を投げる（RFC 6749 §5.2）。
 * `supportedGrantTypes` の既定値は `authorization_code` と `refresh_token` で、ここから外したグラントタイプは、実装されていても拒否する（機能を止める切り替えとして使う）。
 *
 * ここで確かめるのは OP 全体で対応しているかどうかで、クライアントごとの許可（{@link validateClientGrantType}、`unauthorized_client`）とは別に確かめる。
 *
 * @spec RFC 6749 §5.2
 * @throws {TokenError} `invalid_request`: `grant_type` がないとき
 * @throws {TokenError} `unsupported_grant_type`: OP が対応していないグラントタイプのとき
 */
export function validateGrantTypeSupported(
  grantType: string | undefined,
  supportedGrantTypes: string[] = [...DEFAULT_SUPPORTED_GRANT_TYPES],
): 'authorization_code' | 'refresh_token' {
  if (!grantType) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Missing required parameter: grant_type'
    );
  }

  if (
    (grantType !== 'authorization_code' && grantType !== 'refresh_token') ||
    !supportedGrantTypes.includes(grantType)
  ) {
    throw new TokenError(
      TokenErrorCode.UnsupportedGrantType,
      `Unsupported grant_type: ${grantType}`
    );
  }

  return grantType;
}

/**
 * 提示された `client_id` の登録済みクライアントを返す。
 *
 * `authenticatedClientId` には、`extractClientCredentials()` がリクエストから取り出したクライアント ID を渡す。
 * クライアント ID が空のとき（認証情報が提示されていないとき）と、`clientResolver.findClient()` がクライアントを返さないときは、`TokenError`（`invalid_client`）を投げる（RFC 6749 §5.2）。
 * シークレットの照合は、ここでは行わない。
 *
 * @spec RFC 6749 §5.2
 * @throws {TokenError} `invalid_client`: クライアント ID が空のとき、またはクライアントが登録されていないとき
 */
export async function resolveAuthenticatedTokenClient(
  authenticatedClientId: string,
  clientResolver: TokenClientResolver,
): Promise<TokenClientInfo> {
  if (!authenticatedClientId) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication required'
    );
  }

  const client = await clientResolver.findClient(authenticatedClientId);
  if (!client) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication failed'
    );
  }

  return client;
}

/**
 * クライアントが登録していない `grant_type` を拒否する。
 *
 * クライアントの `grantTypes` に `grantType` がなければ、`TokenError`（`unauthorized_client`）を投げる。
 * 認証したクライアントがそのグラントタイプを使う許可を持たないときのエラーコードは `unauthorized_client` である（RFC 6749 §5.2）。
 * `grantTypes` を登録していないクライアントには、既定値の `["authorization_code"]` を当てはめる（OIDC Dynamic Client Registration 1.0 §2、RFC 7591 §2）。
 *
 * OP 全体で対応していないグラントタイプは {@link validateGrantTypeSupported} が `unsupported_grant_type` で拒否するので、ここではクライアントごとの許可だけを確かめる。
 *
 * @spec RFC 6749 §5.2
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec RFC 7591 §2
 * @throws {TokenError} `unauthorized_client`: クライアントがそのグラントタイプを登録していないとき
 */
export function validateClientGrantType(
  client: Pick<TokenClientInfo, 'grantTypes'>,
  grantType: string,
): void {
  if (!clientAllowsGrantType(client, grantType)) {
    throw new TokenError(
      TokenErrorCode.UnauthorizedClient,
      `Client is not authorized to use grant_type: ${grantType}`
    );
  }
}
