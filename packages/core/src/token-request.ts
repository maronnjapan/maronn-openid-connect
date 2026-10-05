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
   * RFC 6749 §2.1 / §3.2.1: public client（`tokenEndpointAuthMethod: 'none'`）は
   * シークレットを持たないため optional。confidential client では必須（未設定なら認証は必ず失敗する）。
   */
  clientSecret?: string;
  /**
   * このクライアントが使用してよい grant_type の一覧。
   * OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 省略時の既定は
   * `["authorization_code"]`（refresh_token は不許可）。
   * 登録外の grant_type は RFC 6749 §5.2 の `unauthorized_client` で拒否される。
   */
  grantTypes?: string[];
  /**
   * このクライアントに登録された Token Endpoint のクライアント認証方式。
   * OIDC Core 1.0 §9 / RFC 7591 §2: 既定は `client_secret_basic`。
   * 未指定時も既定の `client_secret_basic` を強制し、実際に使われた方式が一致しなければ
   * 認証失敗（`invalid_client`）として扱う（認証方式ダウングレード防止）。
   */
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
}

/**
 * クライアント情報を解決するインターフェース
 */
export interface TokenClientResolver {
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
  findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null>;
  /**
   * 認可コードを「使用済み」にする。**物理削除ではなく `used=true` への状態遷移として
   * 実装しなければならない。**
   *
   * 理由（OAuth 2.1 Section 4.1.2 / RFC 9700 §4.13）: 認可コードが再提示されたら、
   * 漏洩の可能性を見て同 grantId の発行済みトークンをすべて失効したい
   * （`revokeTokensByGrantId`）。この失効を発火させるには、再提示されたコードを
   * 「存在するが used:true」として検知できる必要がある。
   *
   * したがって実装は次を満たすこと:
   * - このメソッドはレコードを削除せず `used=true` に更新する（できればアトミックに）。
   * - `findAuthorizationCode` は**少なくとも元の認可コード TTL の間は、used:true の
   *   レコードを返し続ける**（TTL 経過後の eviction は許容）。
   *
   * 物理削除で実装すると、再提示は `not found`（invalid_grant）にはなるが
   * `revokeTokensByGrantId` が**呼ばれず**、漏洩コードから発行済みのトークンが生き残る
   * （SHOULD 違反）。生成 OP では `store.ts` の `consume()`（used 更新）を使い、
   * `delete()`（物理削除）は使わないこと。この契約は各 sample の `conformance.test.ts`
   * で固定している。
   */
  revokeAuthorizationCode(code: string): Promise<void>;
  /**
   * コード再利用が検知された際に、同 grantId を持つアクセストークン・リフレッシュトークンを
   * すべて失効する（OAuth 2.1 Section 4.1.2: SHOULD revoke previously issued tokens）。
   * 未提供の場合、コード自体は invalid_grant として拒否されるが、発行済みトークンは失効されない。
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
   * 現状 acr の判定機構は未実装 (T-009 Hold) のため通常は undefined。
   */
  acr?: string;
  /**
   * 初回認証の Authentication Methods References。
   * OIDC Core 1.0 Section 12.1 SHOULD: refresh の ID Token も同じ amr を保持。
   * acr 同様、判定機構は未実装 (T-009 Hold)。
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
  resolve(token: string): Promise<RefreshTokenInfo | null>;
  /**
   * リフレッシュトークンを「使用済み」にする。**物理削除ではなく `used=true` への状態遷移
   * として実装しなければならない。**
   *
   * 理由（OAuth 2.1 Section 4.3.1 / RFC 9700 §4.14）: rotation 済みの古い
   * リフレッシュトークンが再提示されたら、token family 全体（同 grantId）を失効したい
   * （`revokeTokensByGrantId`）。この失効を発火させるには、再提示されたトークンを
   * 「存在するが used:true」として検知できる必要がある。
   *
   * したがって実装は次を満たすこと:
   * - このメソッドはレコードを削除せず `used=true` に更新する（できればアトミックに）。
   * - `resolve` は**少なくともリフレッシュトークンの absolute lifetime 相当の間は、
   *   used:true のレコードを返し続ける**（lifetime 経過後の eviction は許容）。
   *
   * 物理削除で実装すると、再提示は `not found`（invalid_grant）にはなるが
   * `revokeTokensByGrantId` が**呼ばれず**、漏洩トークンから派生した token family が
   * 生き残る（SHOULD 違反）。この契約は各 sample の `conformance.test.ts` で固定している。
   */
  revokeRefreshToken(token: string): Promise<void>;
  /**
   * リフレッシュトークンの再利用が検知された際に、同 grantId を持つアクセストークン・
   * リフレッシュトークンをすべて失効する（OAuth 2.1 Section 4.3.1: SHOULD revoke
   * the refresh token along with all access tokens previously issued based on it）。
   * 未提供の場合、リフレッシュトークン自体は invalid_grant として拒否されるが、
   * 発行済みの兄弟トークンは失効されない。
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
 * grant_type の存在と OP 全体でのサポート有無を検証する（機能単位のステップ関数）。
 *
 * - 欠落は invalid_request
 * - 実装として扱える grant_type（authorization_code / refresh_token）であっても、
 *   supportedGrantTypes から除外されていれば unsupported_grant_type として拒否する
 *   （RFC 6749 §5.2。機能トグル）
 *
 * クライアント単位の許可（{@link validateClientGrantType} → unauthorized_client）とは
 * 別軸の「OP 全体でのサポート有無」を表す。
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
 * クライアント認証で提示された clientId からクライアント情報を解決する（機能単位のステップ関数）。
 *
 * `extractClientCredentials` が抽出した clientId を受け取り、TokenClientResolver から
 * クライアント情報を取得する。空の clientId（資格情報の提示なし）、および解決できない
 * クライアントは invalid_client として拒否する（RFC 6749 §5.2）。
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
 * クライアント単位の grant_type 認可を検証する（機能単位のステップ関数）。
 *
 * RFC 6749 §5.2: "The authenticated client is not authorized to use this authorization
 * grant type." → unauthorized_client。OP 全体での未サポート（unsupported_grant_type →
 * {@link validateGrantTypeSupported}）とは区別する。
 * 既定 ["authorization_code"]（OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2）。
 */
export function validateClientGrantType(
  client: TokenClientInfo,
  grantType: string,
): void {
  if (!clientAllowsGrantType(client, grantType)) {
    throw new TokenError(
      TokenErrorCode.UnauthorizedClient,
      `Client is not authorized to use grant_type: ${grantType}`
    );
  }
}
