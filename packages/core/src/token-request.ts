import { TokenError, TokenErrorCode } from './token-error.js';
import { validateAuthorizationCodeGrant } from './authorization-code-grant.js';
import { validateRefreshTokenGrant } from './refresh-token-grant.js';

// 後方互換: TokenError / TokenErrorCode は歴史的にこのモジュールが公開してきたため、
// token-error.ts へ分割した後も再exportして既存のimportを壊さない。
export { TokenError, TokenErrorCode } from './token-error.js';
// 機能単位のエントリポイントと各ステップもここから利用できるようにする。
export {
  buildValidatedAuthorizationCodeRequest,
  consumeAuthorizationCode,
  resolveAuthorizationCode,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeGrant,
  validateAuthorizationCodeRedirectUri,
  validateAuthorizationCodeUnused,
  verifyAuthorizationCodePkce,
} from './authorization-code-grant.js';
export {
  buildValidatedRefreshTokenRequest,
  resolveRefreshToken,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenGrant,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenUnused,
} from './refresh-token-grant.js';
export type {
  ResolvedAuthorizationCode,
} from './authorization-code-grant.js';
export type {
  ResolvedRefreshToken,
} from './refresh-token-grant.js';

/**
 * トークンエンドポイントへの生パラメータ（バリデーション前）
 *
 * application/x-www-form-urlencoded 形式のリクエストボディから取得した
 * 生の文字列マップを表す。grant_type は仕様上必須だが、
 * 「バリデーション前」のため型上は optional とし、
 * 欠損の検出は validateTokenRequest 内で行う。
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
   * OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: 既定は `["authorization_code"]`。
   * 未指定時は `["authorization_code"]` として扱う（後方互換: refresh_token は不許可）。
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
 * トークンリクエストのコンテキスト
 * HTTPリクエストのパースとクライアント認証は呼び出し側で実施する
 */
export interface TokenRequestContext {
  params: TokenRequestParams;
  clientResolver: TokenClientResolver;
  authCodeResolver: AuthorizationCodeResolver;
  /** クライアント認証済みのclientId（client_secret_basic または client_secret_post で認証済み） */
  authenticatedClientId: string;
  /** refresh_token grant で使用するリフレッシュトークンリゾルバー */
  refreshTokenResolver?: RefreshTokenResolver;
  /**
   * OP として提供する grant_type の一覧（機能トグル）。
   * 未指定時は `['authorization_code', 'refresh_token']`（従来挙動）。
   * この一覧に無い grant_type は RFC 6749 §5.2 の `unsupported_grant_type` で拒否する。
   * クライアント別の許可（`TokenClientInfo.grantTypes` → `unauthorized_client`）とは
   * 別軸の「OP 全体でのサポート有無」を表す。
   */
  supportedGrantTypes?: string[];
  /**
   * Refresh Token のアイドル（無操作）タイムアウト秒数（任意・オプトイン）。
   * RFC 9700 §4.14.2 は rotation と限定的な有効期限で RT の露出を抑えることを推奨しており、
   * 本オプションはその方針を具体化する追加の失効軸として非活動期間での失効を提供する
   * （inactivity/idle timeout 自体は RFC の規定ではなく Auth0 等で一般的な運用機構）。
   * 未指定または 0 の場合はアイドル失効なし（従来挙動）。値 > 0 かつ
   * `RefreshTokenInfo.lastUsedAt` が存在し `now - lastUsedAt > この値` のとき
   * `invalid_grant` で失効させる。絶対寿命とは独立で、いずれか早い方で失効する。
   */
  refreshTokenIdleTimeoutSeconds?: number;
}

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
   * 呼び出し側はこれを generateTokenResponse の `requestedAcrValues` に渡し、AcrResolver が
   * 要求された acr を満たせるようにする。
   */
  acrValues?: string;
  /** OIDC Core 1.0 §5.5: claims request from the authorization step. */
  claims?: import('./userinfo.js').ClaimsParameter;
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
 * クライアント認証結果からクライアント情報を解決する（機能単位のステップ関数）。
 *
 * authenticateClient 等で認証済みの clientId を受け取り、TokenClientResolver から
 * クライアント情報を取得する。認証されていない（空の）clientId、および解決できない
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
  const allowedGrantTypes = client.grantTypes ?? ['authorization_code'];
  if (!allowedGrantTypes.includes(grantType)) {
    throw new TokenError(
      TokenErrorCode.UnauthorizedClient,
      `Client is not authorized to use grant_type: ${grantType}`
    );
  }
}

/**
 * トークンリクエストをバリデーションする
 *
 * 機能単位のステップ関数を順に呼び出す合成関数。カスタマイズや検証のために
 * ステップ単位で処理を消したり足したりしたい場合は、この関数と同じ順序で
 * 各ステップ関数を直接呼び出すこと（CLI 生成コードはその形で出力される）。
 *
 * バリデーション順序:
 * 1. {@link validateGrantTypeSupported}（OP が提供する grant_type かを判定）
 * 2. {@link resolveAuthenticatedTokenClient} / {@link validateClientGrantType}
 * 3. grant_type に応じた処理（機能単位の関数へディスパッチ）
 *    - authorization_code: {@link validateAuthorizationCodeGrant}
 *    - refresh_token: {@link validateRefreshTokenGrant}
 *
 * @param context トークンリクエストのコンテキスト
 * @returns バリデーション済みのトークンリクエスト
 * @throws {TokenError} バリデーションエラー
 */
export async function validateTokenRequest(
  context: TokenRequestContext
): Promise<ValidatedTokenRequest> {
  const { params, clientResolver, authenticatedClientId } = context;

  // --- 1. grant_type の検証（OP 全体でのサポート有無） ---
  const grantType = validateGrantTypeSupported(
    params.grant_type,
    context.supportedGrantTypes,
  );

  // --- 2. クライアント認証の検証とクライアント別 grant_type 認可 ---
  const client = await resolveAuthenticatedTokenClient(
    authenticatedClientId,
    clientResolver,
  );
  validateClientGrantType(client, grantType);

  // --- 3. grant_type に応じた処理（機能単位の関数へディスパッチ） ---
  if (grantType === 'refresh_token') {
    return validateRefreshTokenGrant(context);
  }

  return validateAuthorizationCodeGrant(context);
}
