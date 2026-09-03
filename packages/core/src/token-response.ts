import { generateIdToken } from './id-token.js';
import type { IdTokenPayload } from './id-token.js';
import { arrayBufferToBase64Url, stringToArrayBuffer, generateRandomString, getJwaAlgorithm, jwaToHashName } from './crypto-utils.js';
import { createJwtAccessTokenIssuer } from './access-token-issuer.js';
import type { AccessTokenIssuer } from './access-token-issuer.js';
import type { AccessTokenPayload } from './access-token.js';
import { filterClaimsByScope, matchesRequestedValue, SCOPE_CLAIMS_MAP } from './userinfo.js';
import type { UserClaims, ClaimsParameter } from './userinfo.js';

/**
 * acr / amr resolver
 *
 * OIDC Core 1.0 §2 で `acr` (Authentication Context Class Reference) と
 * `amr` (Authentication Methods References) は OP の認証ポリシーに依存するため、
 * core 側で値を決められない。利用者がこの resolver を実装して inject することで、
 * 認証コンテキスト → クレーム値のマッピングをアプリケーションごとに表現できる。
 *
 * - `userId`: ID Token の sub（呼び出し側で確定済みのユーザー識別子）
 * - `clientId`: トークンを受け取るクライアント識別子
 * - `requestedAcrValues`: 認可リクエストの `acr_values` （未指定時は undefined）
 *
 * 戻り値が `undefined` の場合は ID Token に acr / amr クレームを含めない
 * （T-009 hold 相当の従来動作）。
 */
export type AcrResolver = (context: {
  userId: string;
  clientId: string;
  requestedAcrValues?: string;
}) => Promise<{ acr: string; amr: string[] } | undefined>;

/**
 * トークンレスポンスの生成オプション
 */
export interface TokenResponseOptions {
  issuer: string;
  subject: string;
  clientId: string;
  scope: string[];
  /**
   * アクセストークン（JWT形式）の署名鍵。
   * idTokenPrivateKey が未指定の場合はIDトークンの署名にも使用される。
   */
  privateKey: CryptoKey;
  accessTokenExpiresIn: number;
  idTokenExpiresIn: number;
  /** アクセストークン署名鍵の kid。idTokenKeyId が未指定の場合はIDトークンにも使用 */
  keyId?: string;
  /**
   * IDトークン専用の署名鍵。
   * 未指定の場合は privateKey をフォールバックとして使用する。
   * OIDC Core 1.0 では id_token_signed_response_alg と他の用途を別管理にできるため、
   * 別鍵で署名できるよう optional として用意する。
   */
  idTokenPrivateKey?: CryptoKey;
  /** IDトークン専用の署名鍵 kid。未指定なら keyId にフォールバック */
  idTokenKeyId?: string;
  nonce?: string;
  authTime?: number;
  /**
   * アクセストークンの audience（resource indicator）。
   * RFC 9068 §3: JWT access token の aud は非空でなければならない。
   * 生成された Provider は UserInfo エンドポイントを含む audience をここに渡す。
   * 未指定または空配列の場合は issuer（OP 自身）をデフォルト audience として使用する。
   */
  audience?: string[];
  /**
   * ID Token の追加 audience（クライアント自身以外に ID Token を受け取る相手）。
   * OIDC Core 1.0 §2 では ID Token の aud は基本的にクライアント（clientId）だが、
   * 仕様上 aud は配列も許容される。ここに値を渡すと aud は `[clientId, ...idTokenAudiences]`
   * の配列となり、複数値になった場合は OIDC Core §3.1.3.7 (4-5) に従い `azp = clientId` を
   * 自動付与する。未指定または clientId のみに重複解決される場合は aud を単一文字列とし azp は
   * 付与しない（Basic OP のデフォルト挙動、後方互換）。合成ポリシーは buildIdTokenAudience に集約。
   */
  idTokenAudiences?: string[];
  /** リフレッシュトークンを発行するか。OAuth 2.1 Section 4.3 */
  issueRefreshToken?: boolean;
  /** リフレッシュトークンの有効期限（秒）。呼び出し側がストレージに保存する際に使用 */
  refreshTokenExpiresIn?: number;
  /**
   * アクセストークン発行戦略（JWT / Opaque）。
   * 未指定の場合は createJwtAccessTokenIssuer() がデフォルトで使われる（後方互換）。
   * Opaque を選ぶ場合でも at_hash は発行された文字列に対して計算するため、
   * OIDC ID Token の at_hash 検証は維持される。
   */
  accessTokenIssuer?: AccessTokenIssuer;
  /**
   * ID Token を発行するか。デフォルト: true。
   * OIDC Core 1.0 Section 12: refresh_token grant では ID Token の発行は任意
   * ("might not contain an id_token")。refresh_token grant の場合は false を渡す。
   */
  issueIdToken?: boolean;
  /**
   * acr / amr を解決する resolver（任意）。
   * authorization_code grant で初回認証時に呼ぶことを想定。
   * 未指定の場合、または resolver が undefined を返した場合は acr / amr クレームを
   * ID Token に含めない（T-009 hold 相当の従来動作）。
   */
  acrResolver?: AcrResolver;
  /**
   * acrResolver に渡す acr_values。認可リクエストの `acr_values` パラメータをそのまま渡す。
   */
  requestedAcrValues?: string;
  /**
   * 直接指定する acr クレーム。
   * OIDC Core 1.0 §12.1: refresh_token grant では初回認証時の acr を保持するため、
   * 呼び出し側が保存済みの値を直接渡せるよう用意する。指定された場合は acrResolver より優先される。
   */
  acr?: string;
  /**
   * 直接指定する amr クレーム。`acr` と同じく §12.1 の refresh 時保持用。
   */
  amr?: string[];
  /**
   * ID Token に scope に応じて含めるユーザクレーム（任意）。
   * OIDC Core 1.0 §5.4 / §12: refresh で scope が削減された場合、ID Token のクレームも
   * 削減後の scope に揃える MUST。filterClaimsByScope で scope 単位にフィルタする。
   * 必須クレーム (sub/iss/aud/exp/iat/at_hash/nonce/auth_time/acr/amr) は上書きされない。
   */
  userClaims?: UserClaims;
  /**
   * OIDC Core 1.0 §5.5: parsed `claims` request parameter from the authorization step.
   * `claims.id_token.acr.values` is fed into the acrResolver as requested acr_values
   * so the resolver can satisfy the requested values where possible. Standard claims
   * requested via the `id_token` member (e.g. `{"id_token":{"email":null}}`) are
   * reflected into the ID Token independently of scope when `userClaims` is provided
   * ({@link pickIdTokenRequestedClaims}). Other id_token claim members are ignored.
   */
  claims?: ClaimsParameter;
}

/**
 * トークンレスポンス
 * OIDC Core 1.0 Section 3.1.3.3
 */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  /**
   * ID Token。authorization_code grant では常に含まれる。
   * refresh_token grant では OIDC Core 1.0 Section 12 により省略可能。
   * issueIdToken=false の場合は含まれない。
   */
  id_token?: string;
  /**
   * 発行されたスコープ。OAuth 2.1 Section 3.2.3 では発行スコープがリクエストと
   * 異なる場合のみ MUST で、同一なら OPTIONAL だが、conformance テスト互換のため常に含める。
   */
  scope: string;
  /** リフレッシュトークン。issueRefreshToken=true の場合に含まれる */
  refresh_token?: string;
}

/**
 * generateTokenResponse の戻り値。
 *
 * `response` は OIDC/OAuth 仕様に沿ってクライアントへ JSON 返却する body。
 * `resolvedAcr` / `resolvedAmr` / `accessTokenJti` は発行時に確定したメタデータで、
 * 呼び出し側が refresh token store / access token store などへ永続化する用途のため公開する。
 * `response` には含めず（仕様外フィールドのため）、JSON 返却時に混入しない。
 */
export interface GenerateTokenResponseResult {
  response: TokenResponse;
  /** authorization_code 経由で resolver / 直接指定により確定した acr。未確定なら undefined */
  resolvedAcr?: string;
  /** authorization_code 経由で resolver / 直接指定により確定した amr。未確定なら undefined */
  resolvedAmr?: string[];
  /**
   * 発行したアクセストークンの `jti`（RFC 9068 §2.2）。
   *
   * アクセストークン文字列自体からは opaque 形式のとき読み取れないため、ここで返す。
   * ストアの metadata として保存しておくと、イントロスペクション（RFC 7662 §2.2）が
   * `jti` を返せる。
   */
  accessTokenJti?: string;
}

/**
 * buildAccessTokenAudience の入力。
 */
export interface AccessTokenAudienceInput {
  /**
   * OP 自身の UserInfo エンドポイント URL。指定時は aud の恒久メンバとして必ず含める
   * （アクセストークンは常に OP の UserInfo エンドポイントで使用できるため）。
   */
  userInfoEndpoint?: string;
  /** 要求された resource indicator（RFC 8707 resource）。userInfoEndpoint の後ろに追加する。 */
  requested?: string[];
  /** 非空フォールバック用の issuer（OP 自身）。userInfoEndpoint も requested も無い場合に使う。 */
  issuer: string;
}

/**
 * アクセストークンの aud を合成する。
 *
 * 各フレームワーク template と core 呼び出し側が同じ規則で aud を組み立てられるよう、
 * audience 合成ポリシーを 1 箇所に集約する。
 *
 * RFC 9068 §3: JWT access token の aud は非空でなければならない。
 * - `userInfoEndpoint` があれば aud の恒久メンバとして先頭に必ず含める（取り除かない）
 * - `requested` の resource indicator を後ろに追加する
 * - 重複は除去する（最初の出現順を保持）
 * - 結果が空なら `issuer` をデフォルト audience とする
 */
export function buildAccessTokenAudience(input: AccessTokenAudienceInput): string[] {
  const { userInfoEndpoint, requested, issuer } = input;
  const members: string[] = [];
  if (userInfoEndpoint) {
    members.push(userInfoEndpoint);
  }
  if (requested) {
    members.push(...requested);
  }
  const deduped = [...new Set(members)];
  return deduped.length > 0 ? deduped : [issuer];
}

/**
 * ID Token の `aud` / `azp` を OIDC Core 1.0 の規則に従って組み立てる。
 *
 * `clientId` を先頭に、追加 audience（`additional`）を後ろに合成し重複を除去する。
 * - 結果が 1 件（＝クライアント自身のみ）: `aud` は単一文字列とし `azp` は付与しない。
 *   OIDC Core §2: 唯一の audience が authorized party と同一のとき azp は SHOULD NOT include。
 * - 結果が複数件: `aud` は配列とし、`azp = clientId` を必ず付与する。
 *   OIDC Core §3.1.3.7 (4-5): aud が複数値のとき azp は REQUIRED。
 *
 * 発行と検証（validatePayload の azp ルール）で同じ非対称を扱えるよう、発行側のポリシーを
 * 1 箇所に集約する。これにより将来 aud を複数化しても azp 付与を忘れる事故を防ぐ。
 */
export interface IdTokenAudienceInput {
  clientId: string;
  /** クライアント自身以外に ID Token を受け取る audience（任意）。 */
  additional?: string[];
}

export interface IdTokenAudienceResult {
  aud: string | string[];
  azp?: string;
}

export function buildIdTokenAudience(input: IdTokenAudienceInput): IdTokenAudienceResult {
  const { clientId, additional } = input;
  const deduped = [...new Set([clientId, ...(additional ?? [])])];
  if (deduped.length <= 1) {
    return { aud: clientId };
  }
  return { aud: deduped, azp: clientId };
}

/**
 * アクセストークン payload 組み立てのオプション。
 */
export interface AccessTokenPayloadInput {
  issuer: string;
  subject: string;
  clientId: string;
  scope: string[];
  /**
   * アクセストークンの audience（resource indicator）。
   * 空・未指定なら issuer をデフォルト audience にフォールバックする
   * （RFC 9068 §3: aud は非空でなければならない）。
   */
  audience?: string[];
  /** 有効期間（秒） */
  expiresIn: number;
  /** 発行時刻（Unix epoch 秒）。省略時はシステム時刻 */
  issuedAt?: number;
  /**
   * トークンの一意識別子（RFC 9068 §2.2 の `jti`）。
   * 省略時は 128bit の CSPRNG 値を生成する。既存の識別子を再利用したい場合のみ渡す。
   */
  jti?: string;
}

/**
 * ステップ: アクセストークンの payload を組み立てる
 * RFC 9068 §2.2: iss / sub / aud / exp / iat / jti / scope / client_id
 *
 * 実際の発行（JWT 署名 / Opaque 文字列）は {@link AccessTokenIssuer} の責務。
 * 独自クレームを載せたい場合は戻り値へ追加してから issuer に渡す。
 *
 * 戻り値の `jti` は発行ごとに異なる。呼び出し側はこの値をトークンのメタデータとして
 * ストアへ保存しておくと、イントロスペクション（RFC 7662 §2.2）が `jti` を返せる。
 */
export function buildAccessTokenPayload(
  input: AccessTokenPayloadInput,
): AccessTokenPayload {
  const { issuer, subject, clientId, scope, audience, expiresIn } = input;
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);

  return {
    iss: issuer,
    sub: subject,
    aud: buildAccessTokenAudience({ requested: audience, issuer }),
    exp: issuedAt + expiresIn,
    iat: issuedAt,
    // RFC 9068 §2.2: jti は REQUIRED。RFC 7519 §4.1.7 は「別のトークンに同じ値が
    // 割り当てられる確率が無視できる」ことを要求する。128bit の CSPRNG 値で満たす。
    //
    // 併せて、これが「同一秒・同一入力の 2 回発行」を別トークンにする唯一の可変要素
    // でもある。RS256（RFC 8017 §8.2 の RSASSA-PKCS1-v1_5）は決定的な署名方式なので、
    // jti が無いと 2 本の grant のアクセストークンがバイト単位で同一になり、トークン
    // 文字列をキーにするストアで後勝ちの上書きが起きる（＝先の grant に対する
    // grantId 単位の失効が黙って効かなくなる）。
    jti: input.jti ?? generateRandomString(16),
    scope: scope.join(' '),
    client_id: clientId,
  };
}

/**
 * ステップ: at_hash を計算する
 * OIDC Core 1.0 Section 3.1.3.6:
 * ID Token の JOSE Header `alg` で使われるハッシュ関数で access_token をハッシュし、
 * 左半分を取り出して base64url エンコードする。
 * （例: alg=RS256→SHA-256, RS384/ES384→SHA-384, RS512/ES512→SHA-512）
 *
 * 左半分の算出は `slice(0, byteLength / 2)` で alg 非依存に一般化される
 * （SHA-256→16B, SHA-384→24B, SHA-512→32B）。
 *
 * @param accessToken ハッシュ対象のアクセストークン
 * @param idTokenPrivateKey ID Token の署名鍵。この鍵の alg からハッシュ関数を決める
 */
export async function computeAtHash(
  accessToken: string,
  idTokenPrivateKey: CryptoKey,
): Promise<string> {
  const hashName = jwaToHashName(getJwaAlgorithm(idTokenPrivateKey));
  const tokenBytes = stringToArrayBuffer(accessToken);
  const hashBuffer = await crypto.subtle.digest(hashName, tokenBytes);
  const leftHalf = hashBuffer.slice(0, hashBuffer.byteLength / 2);
  return arrayBufferToBase64Url(leftHalf);
}

/**
 * acr / amr 解決のオプション。
 */
export interface ResolveAcrAmrInput {
  subject: string;
  clientId: string;
  /** 直接指定する acr（OIDC Core 1.0 §12.1: refresh 時の初回値保持用） */
  acr?: string;
  /** 直接指定する amr（同上） */
  amr?: string[];
  /** 認可リクエストの acr_values */
  requestedAcrValues?: string;
  /** OIDC Core 1.0 §5.5: claims パラメータ。acr_values 未指定時の種として使う */
  claims?: ClaimsParameter;
  /** acr / amr を解決する resolver */
  acrResolver?: AcrResolver;
}

export interface ResolvedAcrAmr {
  acr?: string;
  amr?: string[];
}

/**
 * ステップ: ID Token に載せる acr / amr を解決する
 *
 * 優先順位:
 * 1. 呼び出し側が直接指定した acr / amr（refresh 時に §12.1 の初回値を保持するケース）
 * 2. acrResolver（新規認証時）
 * 3. どちらも無ければ省略（core は認証ポリシーを決め打ちしない）
 *
 * OIDC Core 1.0 §5.5.1.1: `claims.id_token.acr.values` は acr_values 要求と等価。
 * `requestedAcrValues` が無い場合はこれを resolver への要求値として渡す。
 */
export async function resolveAcrAmr(input: ResolveAcrAmrInput): Promise<ResolvedAcrAmr> {
  const { subject, clientId, acr, amr, requestedAcrValues, claims, acrResolver } = input;

  if (acr !== undefined || amr !== undefined) {
    return { acr, amr };
  }
  if (!acrResolver) {
    return { acr: undefined, amr: undefined };
  }

  // OIDC Core 1.0 §5.5.1.1: claims.id_token.acr.values is equivalent to
  // requesting these acr values. Use it to seed acrResolver when the request
  // did not provide a separate `acr_values` parameter.
  let effectiveRequestedAcrValues = requestedAcrValues;
  if (effectiveRequestedAcrValues === undefined && claims?.id_token) {
    const acrEntry = claims.id_token['acr'];
    if (acrEntry && Array.isArray(acrEntry.values)) {
      const stringValues = acrEntry.values.filter((v): v is string => typeof v === 'string');
      if (stringValues.length > 0) {
        effectiveRequestedAcrValues = stringValues.join(' ');
      }
    }
  }

  const result = await acrResolver({
    userId: subject,
    clientId,
    requestedAcrValues: effectiveRequestedAcrValues,
  });

  return { acr: result?.acr, amr: result?.amr };
}

/**
 * `claims.id_token` メンバーで要求できる標準クレームの許可リスト。
 *
 * OIDC Core 1.0 §5.4 の scope 対応クレーム（profile / email / address / phone）に限定する。
 * `sub`・`acr`・プロトコルクレーム（iss / aud / exp / iat / at_hash / nonce / auth_time /
 * amr / azp）はこの集合に含まれないため、`claims` パラメータ経由で ID Token の
 * 確定済みクレームを上書き・注入することはできない。
 * - `sub` の値要求はトークン発行先のバインディングというセキュリティ上の意味を持つため
 *   別トピックとして扱い、ここでは反映しない
 * - `acr` は {@link resolveAcrAmr} の seed 経路（§5.5.1.1）が担うため二重処理しない
 */
export const ID_TOKEN_REQUESTABLE_CLAIMS: ReadonlySet<string> = new Set(
  Object.values(SCOPE_CLAIMS_MAP).flat(),
);

/**
 * ステップ: `claims.id_token` メンバー（OIDC Core 1.0 §5.5）で個別要求された
 * 標準クレームを、ID Token に載せる形で取り出す。
 *
 * §5.5: 「id_token — Requests that the listed individual Claims be returned in
 * the ID Token.」に対応する。granted scope とは独立に、要求されたクレームだけを返す。
 *
 * - {@link ID_TOKEN_REQUESTABLE_CLAIMS} にある標準クレームのみ対象（許可リスト方式）
 * - ユーザーが値を持たないクレームは省略する。§5.5.1: essential クレームを返せない
 *   場合でもエラーにしてはならない（MUST NOT）
 * - `value` / `values` 制約は実値との深い等価で判定し、不一致なら省略する
 *   （UserInfo 側の {@link matchesRequestedValue} と同一規則）
 *
 * 戻り値に `sub` やプロトコルクレームが含まれることはないため、組み立て済みの
 * ID Token payload へ `Object.assign` で重ねても確定済みクレームは壊れない。
 */
export function pickIdTokenRequestedClaims(
  userClaims: UserClaims,
  claims?: ClaimsParameter,
): Partial<UserClaims> {
  const result: Record<string, unknown> = {};
  if (!claims?.id_token) {
    return result as Partial<UserClaims>;
  }

  for (const [claimName, entry] of Object.entries(claims.id_token)) {
    if (!ID_TOKEN_REQUESTABLE_CLAIMS.has(claimName)) continue;
    const value = (userClaims as unknown as Record<string, unknown>)[claimName];
    if (value === undefined || value === null) continue;
    if (!matchesRequestedValue(value, entry)) continue;
    result[claimName] = value;
  }

  return result as Partial<UserClaims>;
}

/**
 * ID Token payload 組み立てのオプション。
 */
export interface IdTokenPayloadInput {
  issuer: string;
  subject: string;
  clientId: string;
  scope: string[];
  /** 有効期間（秒） */
  expiresIn: number;
  /** 発行時刻（Unix epoch 秒）。省略時はシステム時刻 */
  issuedAt?: number;
  /** OIDC Core 1.0 §3.1.3.6: アクセストークンとの結合を示す at_hash */
  atHash?: string;
  nonce?: string;
  authTime?: number;
  acr?: string;
  amr?: string[];
  /** クライアント自身以外に ID Token を受け取る audience */
  idTokenAudiences?: string[];
  /** scope に応じて含めるユーザクレーム */
  userClaims?: UserClaims;
  /**
   * OIDC Core 1.0 §5.5: Authorization Request の `claims` パラメータ。
   * `id_token` メンバーで個別要求された標準クレームを、scope と独立に ID Token へ
   * 反映する（{@link pickIdTokenRequestedClaims}）。userClaims が無い場合は反映しない。
   */
  claims?: ClaimsParameter;
}

/**
 * ステップ: ID Token の payload を組み立てる
 * OIDC Core 1.0 Section 2 / 3.1.3.6 / 5.4
 *
 * 署名は {@link generateIdToken} の責務。独自クレームを載せたい場合は
 * 戻り値へ追加してから署名すること（必須クレームは上書きされない）。
 */
export function buildIdTokenPayload(input: IdTokenPayloadInput): IdTokenPayload {
  const {
    issuer,
    subject,
    clientId,
    scope,
    expiresIn,
    atHash,
    nonce,
    authTime,
    acr,
    amr,
    idTokenAudiences,
    userClaims,
    claims,
  } = input;
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {};

  // OIDC Core 1.0 §5.4 / §12: scope に応じてユーザクレームを含める。
  // 必須クレーム (iss/sub/aud/exp/iat/at_hash etc.) は後続の代入で上書きされるため
  // ここではユーザクレーム由来の sub などによる spoof を防げる。
  if (userClaims) {
    Object.assign(payload, filterClaimsByScope(userClaims, scope));

    // OIDC Core 1.0 §5.5: claims.id_token で個別要求された標準クレームを scope と
    // 独立に反映する。許可リスト（ID_TOKEN_REQUESTABLE_CLAIMS）でプロトコルクレームは
    // 除外済みだが、後続のプロトコルクレーム代入が最終値を確定する二重防御とする。
    Object.assign(payload, pickIdTokenRequestedClaims(userClaims, claims));
  }

  payload.iss = issuer;
  payload.sub = subject;
  // OIDC Core 1.0 §2 / §3.1.3.7 (4-5): build aud/azp via buildIdTokenAudience so the
  // array case is handled correctly. Default (no idTokenAudiences) → aud = clientId
  // (single string), azp omitted. When additional audiences are supplied → aud becomes
  // an array and azp = clientId is emitted, so a multi-audience ID Token can never drop
  // the azp required by OIDC Core 1.0 Section 2 for multiple audiences.
  const { aud, azp } = buildIdTokenAudience({ clientId, additional: idTokenAudiences });
  payload.aud = aud;
  if (azp !== undefined) {
    payload.azp = azp;
  }
  payload.exp = issuedAt + expiresIn;
  payload.iat = issuedAt;
  if (atHash !== undefined) {
    payload.at_hash = atHash;
  }
  if (nonce !== undefined) {
    payload.nonce = nonce;
  }
  if (authTime !== undefined) {
    payload.auth_time = authTime;
  }
  if (acr !== undefined) {
    payload.acr = acr;
  }
  if (amr !== undefined) {
    payload.amr = amr;
  }

  return payload as IdTokenPayload;
}

/**
 * トークンレスポンスを生成する
 *
 * 各ステップ関数を合成した後方互換 API。CLI が生成する Provider はこの合成関数
 * ではなく個々のステップ関数を順に呼び出すため、利用者は ID Token へ独自クレームを
 * 足したり、発行処理を差し替えたりできる。
 *
 * アクセストークンとIDトークンを生成し、OIDC準拠のレスポンスを返す。
 * - アクセストークン: {@link buildAccessTokenPayload} + {@link AccessTokenIssuer}
 * - IDトークン: {@link computeAtHash} + {@link resolveAcrAmr} +
 *   {@link buildIdTokenPayload} + {@link generateIdToken}
 *
 * @param options トークンレスポンスの生成オプション
 * @returns トークンレスポンス
 */
export async function generateTokenResponse(options: TokenResponseOptions): Promise<GenerateTokenResponseResult> {
  const {
    issuer,
    subject,
    clientId,
    scope,
    privateKey,
    accessTokenExpiresIn,
    idTokenExpiresIn,
    keyId,
    idTokenPrivateKey,
    idTokenKeyId,
    nonce,
    authTime,
    audience,
    idTokenAudiences,
    issueRefreshToken,
    accessTokenIssuer,
    issueIdToken = true,
    acrResolver,
    requestedAcrValues,
    acr: directAcr,
    amr: directAmr,
    userClaims,
    claims,
  } = options;

  // IDトークン専用鍵が指定されていなければアクセストークンと同じ鍵を使用
  const idtKey = idTokenPrivateKey ?? privateKey;
  const idtKid = idTokenKeyId ?? keyId;

  const now = Math.floor(Date.now() / 1000);

  // RFC 9068 §3: JWT access token の aud は非空でなければならない。
  // 通常は呼び出し側（生成された Provider）が UserInfo エンドポイントを含む audience を渡すため
  // それをそのまま使う。core 自身は UserInfo エンドポイントのパスを知り得ないため、ここでは
  // requested として渡された audience のみを合成し、空なら issuer をデフォルトにフォールバックする。
  // 合成・重複除去・非空フォールバックのポリシーは buildAccessTokenAudience に集約する。
  const accessTokenPayload = buildAccessTokenPayload({
    issuer,
    subject,
    clientId,
    scope,
    audience,
    expiresIn: accessTokenExpiresIn,
    issuedAt: now,
  });

  // アクセストークンの生成（issuer 抽象でJWT/Opaqueを切替）
  const issuerImpl = accessTokenIssuer ?? createJwtAccessTokenIssuer();
  const accessToken = await issuerImpl.issue({
    payload: accessTokenPayload,
    privateKey,
    keyId,
  });

  let idToken: string | undefined;
  // acr / amr resolution outcome (lifted out of issueIdToken block so it can be
  // returned to the caller for refresh token persistence — OIDC Core 1.0 §12.1).
  let resolvedAcr: string | undefined;
  let resolvedAmr: string[] | undefined;

  if (issueIdToken) {
    // at_hash の計算 (OIDC Core 1.0 Section 3.1.3.6)
    // ハッシュ関数は ID Token の署名 alg に追従させる（idtKey で署名するため idtKey の alg を参照）。
    const atHash = await computeAtHash(accessToken, idtKey);

    ({ acr: resolvedAcr, amr: resolvedAmr } = await resolveAcrAmr({
      subject,
      clientId,
      acr: directAcr,
      amr: directAmr,
      requestedAcrValues,
      claims,
      acrResolver,
    }));

    const idTokenPayload = buildIdTokenPayload({
      issuer,
      subject,
      clientId,
      scope,
      expiresIn: idTokenExpiresIn,
      issuedAt: now,
      atHash,
      nonce,
      authTime,
      acr: resolvedAcr,
      amr: resolvedAmr,
      idTokenAudiences,
      userClaims,
      claims,
    });

    idToken = await generateIdToken({
      payload: idTokenPayload,
      privateKey: idtKey,
      keyId: idtKid,
    });
  }

  return {
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenExpiresIn,
      id_token: idToken,
      scope: scope.join(' '),
      refresh_token: issueRefreshToken ? generateRandomString(32) : undefined,
    },
    resolvedAcr,
    resolvedAmr,
    accessTokenJti: accessTokenPayload.jti,
  };
}
