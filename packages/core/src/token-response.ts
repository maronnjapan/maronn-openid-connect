import type { IdTokenPayload } from './id-token.js';
import { arrayBufferToBase64Url, stringToArrayBuffer, generateRandomString, getJwaAlgorithm, jwaToHashName } from './crypto-utils.js';
import type { AccessTokenPayload } from './access-token.js';
import { filterClaimsByScope } from './userinfo.js';
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
 * 戻り値が `undefined` の場合は ID Token に acr / amr クレームを含めない。
 */
export type AcrResolver = (context: {
  userId: string;
  clientId: string;
  requestedAcrValues?: string;
}) => Promise<{ acr: string; amr: string[] } | undefined>;

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

  const result = await acrResolver({
    userId: subject,
    clientId,
    requestedAcrValues: selectRequestedAcrValues(requestedAcrValues, claims),
  });

  return { acr: result?.acr, amr: result?.amr };
}

/**
 * acr resolver へ渡す要求 acr 値を選ぶ。acr_values パラメータがあればそれを使う。
 * 無ければ OIDC Core 1.0 §5.5.1.1 に従い、`claims.id_token.acr.values` の文字列を空白で連結する。
 */
export function selectRequestedAcrValues(
  requestedAcrValues: string | undefined,
  claims: ClaimsParameter | undefined,
): string | undefined {
  if (requestedAcrValues !== undefined) return requestedAcrValues;

  const acrEntry = claims?.id_token?.['acr'];
  if (acrEntry && Array.isArray(acrEntry.values)) {
    const stringValues = acrEntry.values.filter((v): v is string => typeof v === 'string');
    if (stringValues.length > 0) {
      return stringValues.join(' ');
    }
  }
  return undefined;
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
  } = input;
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {};

  // OIDC Core 1.0 §5.4 / §12: scope に応じてユーザクレームを含める。
  // 必須クレーム (iss/sub/aud/exp/iat/at_hash etc.) は後続の代入で上書きされるため
  // ここではユーザクレーム由来の sub などによる spoof を防げる。
  if (userClaims) {
    Object.assign(payload, filterClaimsByScope(userClaims, scope));
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
