import type { IdTokenPayload } from './id-token.js';
import { arrayBufferToBase64Url, stringToArrayBuffer, generateRandomString, getJwaAlgorithm, jwaToHashName } from './crypto-utils.js';
import type { AccessTokenPayload } from './access-token.js';
import { DEFAULT_REQUESTABLE_CLAIMS, filterClaimsByScope, matchesRequestedClaimValue } from './userinfo.js';
import type { UserClaims, ClaimsParameter } from './userinfo.js';
import { parseAcrValues } from './acr.js';

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
 * - `requestedAcrValues`: 認可リクエストの `acr_values`（優先順の空白区切り。未指定時は
 *   `claims.id_token.acr.values` を連結した値、どちらも無ければ undefined）
 *
 * 戻り値の acr / amr は ID Token の `acr` / `amr` になる。アクセストークンにも acr を載せるときは、
 * 同じ acr を {@link buildAccessTokenPayload} の `acr` に渡す（RFC 9068 §2.2.1）。
 * 戻り値が `undefined` の場合は acr / amr クレームを含めない。
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
 * アクセストークンの `aud` に入れる値の配列を返す。
 *
 * `userInfoEndpoint` があれば先頭に入れ、その後ろに `requested`（`resource` パラメータで要求されたリソース、RFC 8707）を並べて、重複を取り除く（最初に現れた位置に残す）。
 * 結果が空なら、`issuer` だけの配列を返す。
 * JWT のアクセストークンの `aud` は空であってはならないためである（RFC 9068 §3）。
 *
 * `userInfoEndpoint` を常に入れるのは、どのアクセストークンも OP の UserInfo エンドポイントで使えるようにするためである。
 * 各フレームワークのテンプレートと core の呼び出し側が同じ規則で `aud` を組み立てられるように、規則をこの関数にまとめている。
 *
 * @spec RFC 9068 §3
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

/**
 * ID トークンの `aud` と `azp` を決めて返す。
 *
 * `clientId` を先頭に、`additional`（クライアント自身以外のオーディエンス）を後ろに並べて、重複を取り除く。
 * 結果がクライアント自身だけなら、`aud` を `clientId` の文字列にし、`azp` は付けない。
 * 結果が複数なら、`aud` をその配列にし、`azp` に `clientId` を入れる。
 *
 * @spec OIDC Core 1.0 §2
 */
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
  /**
   * トークンを発行した認証が満たした acr（OIDC Core 1.0 §2）。同時に発行する ID Token の
   * `acr` と同じ値を渡す。省略時は `acr` クレームを含めない。
   */
  acr?: string;
}

/**
 * アクセストークンのペイロードを組み立てて返す。
 *
 * 返すペイロードは `iss`、`sub`、`aud`、`exp`、`iat`、`jti`、`scope`、`client_id` を持ち（RFC 9068 §2.2）、`acr` を渡したときだけ `acr` も持つ（RFC 9068 §2.2.1）。
 * `aud` は `audience` から重複を取り除いた配列で、`audience` が空か省略されていれば `issuer` だけの配列にする（{@link buildAccessTokenAudience}）。
 * `iat` は `issuedAt`（省略したときは現在のエポック秒）、`exp` は `iat` に `expiresIn` を足した値で、`scope` はスコープを半角空白でつないだ文字列である。
 * `jti` を省略すると 128 ビットの乱数から作った値を入れるので、`jti` は発行のたびに異なる。
 *
 * トークンの発行（JWT への署名や、不透明な文字列の生成）は {@link AccessTokenIssuer} が行う。
 * 独自のクレームを加えたいときは、返したペイロードに加えてから `AccessTokenIssuer` に渡す。
 * 呼び出し側が `jti` をトークンのメタデータとしてストアに保存しておくと、イントロスペクションが `jti` を返せる（RFC 7662 §2.2）。
 *
 * @spec RFC 9068 §2.2
 * @spec RFC 9068 §2.2.1
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
    // `jti` を渡されなければ、暗号論的に安全な 128 ビットの乱数から作る。
    // `jti` は必須であり（RFC 9068 §2.2）、別のトークンに同じ値が割り当てられる確率を無視できるほど小さくしなければならない（RFC 7519 §4.1.7）。
    //
    // `jti` は、同じ秒に同じ入力で 2 回発行したトークンを別のトークンにする唯一の値でもある。
    // RS256（RFC 8017 §8.2 の RSASSA-PKCS1-v1_5）は同じ入力から同じ署名を作る方式なので、`jti` がないと、二つのグラントのアクセストークンがバイト単位で同じになる。
    // すると、トークンの文字列をキーにするストアで後のトークンが先のトークンのレコードを上書きし、先のグラントをグラント ID で失効させても、エラーにならないまま、そのトークンは失効しない。
    jti: input.jti ?? generateRandomString(16),
    scope: scope.join(' '),
    client_id: clientId,
    // `acr` を渡されたときだけ `acr` を入れる（RFC 9068 §2.2.1 では省略できるクレームである）。
    // リソースサーバーは、トークンがどの認証コンテキストで発行されたかを `acr` で判断できる。
    ...(input.acr !== undefined ? { acr: input.acr } : {}),
  };
}

/**
 * アクセストークンの `at_hash` を計算して返す。
 *
 * `at_hash` は、ID トークンの JOSE ヘッダーの `alg` が使うハッシュ関数でアクセストークンをハッシュし、左半分を base64url で符号化した値である（OIDC Core 1.0 §3.1.3.6）。
 * ハッシュ関数は `idTokenPrivateKey` のアルゴリズムから決める（RS256 と ES256 なら SHA-256、RS384 と ES384 なら SHA-384、RS512 と ES512 なら SHA-512）。
 * 左半分はハッシュ値の前半のバイト（SHA-256 なら 16 バイト、SHA-384 なら 24 バイト、SHA-512 なら 32 バイト）なので、`alg` によらず同じ計算で求まる。
 * 対応していないアルゴリズムの鍵には `Error` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.3.6
 * @param accessToken ハッシュするアクセストークン
 * @param idTokenPrivateKey ID トークンの署名鍵（この鍵のアルゴリズムからハッシュ関数を決める）
 */
export async function computeAtHash(
  accessToken: string,
  idTokenPrivateKey: CryptoKey,
): Promise<string> {
  return computeLeftHalfHash(accessToken, idTokenPrivateKey);
}

/**
 * 認可コードの `c_hash` を計算して返す。
 *
 * `c_hash` は、ID トークンの JOSE ヘッダーの `alg` が使うハッシュ関数で認可コードの ASCII 表現をハッシュし、左半分を base64url で符号化した値で、対象が違うだけで `at_hash` と同じ求め方である（{@link computeAtHash}）。
 * ハイブリッドフローで認可エンドポイントが認可コードと一緒に ID トークンを返すとき（`code id_token` と `code id_token token`）、ID トークンは `c_hash` を含まなければならない（OIDC Core 1.0 §3.3.2.11）。
 *
 * @spec OIDC Core 1.0 §3.3.2.11
 * @param code ハッシュする認可コード
 * @param idTokenPrivateKey ID トークンの署名鍵（この鍵のアルゴリズムからハッシュ関数を決める）
 */
export async function computeCHash(
  code: string,
  idTokenPrivateKey: CryptoKey,
): Promise<string> {
  return computeLeftHalfHash(code, idTokenPrivateKey);
}

/**
 * 値のハッシュの左半分を base64url で符号化して返す。
 *
 * `idTokenPrivateKey` のアルゴリズム（`alg`）に対応するハッシュ関数で `value` のバイト列をハッシュし、ハッシュ値の前半のバイトを base64url で符号化する。
 * `at_hash` と `c_hash` に共通の求め方である（OIDC Core 1.0 §3.1.3.6、§3.3.2.11）。
 * 対応していないアルゴリズムの鍵には `Error` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.3.6
 * @spec OIDC Core 1.0 §3.3.2.11
 */
async function computeLeftHalfHash(value: string, idTokenPrivateKey: CryptoKey): Promise<string> {
  const hashName = jwaToHashName(getJwaAlgorithm(idTokenPrivateKey));
  const valueBytes = stringToArrayBuffer(value);
  const hashBuffer = await crypto.subtle.digest(hashName, valueBytes);
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
 * トークンに入れる `acr` と `amr` を決めて返す。
 *
 * 次の順に決める:
 * - 呼び出し側が `acr` か `amr` を渡したときは、渡された値を返す（リフレッシュで最初の認証の値を引き継ぐとき、OIDC Core 1.0 §12.1）。
 * - `acrResolver` があれば、それが返した値を返す（新しく認証したとき）。
 * - どちらもなければ、どちらも `undefined` を返す（core は認証のポリシーを決めない）。
 *
 * `acrResolver` には、サブジェクト、クライアント ID、要求された `acr` の値を渡す。
 * 要求された値は認可リクエストの `acr_values` で、ないときは `claims` パラメータの `claims.id_token.acr.values` を使う（{@link selectRequestedAcrValues}）。
 * `claims.id_token.acr.values` は、`acr_values` での要求と同じ意味を持つためである（OIDC Core 1.0 §5.5.1.1）。
 * 呼び出し側は、返した `acr` と `amr` を ID トークンに入れ、`acr` をアクセストークンにも入れる。
 *
 * @spec OIDC Core 1.0 §12.1
 * @spec OIDC Core 1.0 §5.5.1.1
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
 * 要求された `acr` の値のうち、最も優先する値を返す。
 *
 * `acr_values` は値を優先順に並べるので（OIDC Core 1.0 §3.1.2.1）、半角空白で分けた最初の値を返す。
 * `requestedAcrValues` が `undefined` のとき、または値が一つもないときは `undefined` を返す。
 *
 * `AcrResolver` を使わない構成で、要求された `acr` をそのままトークンの `acr` にするときに使う。
 * この値は要求をそのまま信じたもので、OP が実際に行った認証を表すとは限らない。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function selectPreferredAcr(requestedAcrValues: string | undefined): string | undefined {
  if (requestedAcrValues === undefined) return undefined;
  return parseAcrValues(requestedAcrValues)[0];
}

/**
 * `acrResolver` に渡す、要求された `acr` の値を返す。
 *
 * `acr_values` パラメータの値（`requestedAcrValues`）があれば、それをそのまま返す。
 * なければ、`claims.id_token.acr.values` の文字列の値を半角空白でつないで返す（OIDC Core 1.0 §5.5.1.1）。
 * どちらもないとき（`values` に文字列が一つもないときを含む）は `undefined` を返す。
 *
 * @spec OIDC Core 1.0 §5.5.1.1
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
  /** OIDC Core 1.0 §3.3.2.11: Hybrid Flow で一緒に返す認可コードとの結合を示す c_hash */
  cHash?: string;
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
 * ID トークンのペイロードを組み立てて返す。
 *
 * `userClaims` があれば、まず `scope` に応じたユーザーのクレームを入れる（{@link filterClaimsByScope}、OIDC Core 1.0 §5.4）。
 * その後で `iss`、`sub`、`aud`、`exp`、`iat` を代入し、`azp`、`at_hash`、`c_hash`、`nonce`、`auth_time`、`acr`、`amr` は値があるときだけ代入する。
 * 必須のクレームを後から代入するので、ユーザーのクレームの `sub` などで必須のクレームを偽ることはできない。
 * `aud` と `azp` は {@link buildIdTokenAudience} で決め、`iat` は `issuedAt`（省略したときは現在のエポック秒）、`exp` は `iat` に `expiresIn` を足した値にする。
 *
 * 署名は {@link generateIdToken} が行う。
 * 独自のクレームを加えたいときは、返したペイロードに加えてから署名する。
 *
 * @spec OIDC Core 1.0 §2
 * @spec OIDC Core 1.0 §3.1.3.6
 * @spec OIDC Core 1.0 §3.3.2.11
 * @spec OIDC Core 1.0 §5.4
 */
export function buildIdTokenPayload(input: IdTokenPayloadInput): IdTokenPayload {
  const {
    issuer,
    subject,
    clientId,
    scope,
    expiresIn,
    atHash,
    cHash,
    nonce,
    authTime,
    acr,
    amr,
    idTokenAudiences,
    userClaims,
  } = input;
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {};

  // スコープに応じたユーザーのクレームを入れる（OIDC Core 1.0 §5.4、§12）。
  // 必須のクレーム（`iss`、`sub`、`aud`、`exp`、`iat`、`at_hash` など）は後の代入で上書きするので、ユーザーのクレームの `sub` などで値を偽ることはできない。
  if (userClaims) {
    Object.assign(payload, filterClaimsByScope(userClaims, scope));
  }

  payload.iss = issuer;
  payload.sub = subject;
  // `aud` と `azp` は `buildIdTokenAudience()` で決める（OIDC Core 1.0 §2、§3.1.3.7 の 4 と 5）。
  // `idTokenAudiences` がなければ、`aud` を `clientId` の文字列にし、`azp` は付けない。
  // 追加のオーディエンスがあれば、`aud` を配列にして `azp` に `clientId` を入れるので、複数のオーディエンスを持つ ID トークンに必要な `azp`（OIDC Core 1.0 §2）が抜けることはない。
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
  if (cHash !== undefined) {
    payload.c_hash = cHash;
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
 * ID Token が自身で持つクレーム（OIDC Core 1.0 §2、§3.1.3.6 / §3.2.2.10 / §3.3.2.11 の
 * at_hash と c_hash）。認証と発行の結果で決まるので、claims.id_token で要求されても
 * End-User のクレームからは取らない。
 */
const ID_TOKEN_OWN_CLAIMS: ReadonlySet<string> = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'azp',
  'at_hash',
  'c_hash',
]);

/**
 * 個別に要求されたクレームをペイロードに加えて返す。
 *
 * `claims` パラメータの `id_token` メンバーで個別に要求されたクレームは、ID トークンの既定のクレームに加えて返すよう要求されたものである（OIDC Core 1.0 §5.5）。
 * このうち、エンドユーザーのクレーム（`userClaims`）に値があるものをペイロードに加える。
 * `value` か `values` が指定されたクレームは、実際の値が一致するときだけ加える。
 * 値がないクレームと一致しないクレームは、エラーにせずに省く（OIDC Core 1.0 §5.5.1）。
 *
 * ID トークン自身のクレーム（`iss`、`sub`、`aud`、`exp`、`iat`、`auth_time`、`nonce`、`acr`、`amr`、`azp`、`at_hash`、`c_hash`）は、エンドユーザーのクレームから取らない。
 * ペイロードがすでに持つクレームも置き換えない。
 * `acr` の要求は、`acr_values` と同じく {@link resolveAcrAmr} が扱う（OIDC Core 1.0 §5.5.1.1）。
 *
 * 読み出すのは、許可リスト（`allowedClaimNames`、既定値は {@link DEFAULT_REQUESTABLE_CLAIMS}）にある名前のクレームだけである。
 * `claims` のキーの名前は RP が自由に指定できるので、確かめずに読むと、リゾルバが返した余分なフィールド（データベースの行など）が、スコープによる制限を通らずに ID トークンで開示されてしまう。
 * 許可リストにないクレームも、エラーにせずに省く（OIDC Core 1.0 §5.5.1 は、要求されたクレームを返せないときにエラーを返すことを禁じている）。
 *
 * `userClaims` か `claims.id_token` がなければ、渡されたペイロードをそのまま返す。
 * それ以外のときは、ペイロードを複製してからクレームを加えるので、渡されたペイロードは変更しない。
 *
 * @spec OIDC Core 1.0 §5.5
 * @spec OIDC Core 1.0 §5.5.1
 * @param payload {@link buildIdTokenPayload} が組み立てたペイロード
 * @param userClaims エンドユーザーのクレーム（`undefined` なら `payload` をそのまま返す）
 * @param claimsParameter 認可リクエストの `claims` パラメータ
 * @param allowedClaimNames `claims` で要求されたときに読み出してよいクレームの名前（既定値は標準のクレームの名前）。
 *   ディスカバリーの `claims_supported` と同じ名前を公開する OP は、その一覧を渡す。
 * @returns 要求されたクレームを加えたペイロード
 */
export function applyRequestedIdTokenClaims(
  payload: IdTokenPayload,
  userClaims: UserClaims | undefined,
  claimsParameter?: ClaimsParameter,
  allowedClaimNames: ReadonlySet<string> = DEFAULT_REQUESTABLE_CLAIMS,
): IdTokenPayload {
  const requested = claimsParameter?.id_token;
  if (userClaims === undefined || requested === undefined) return payload;

  const result: IdTokenPayload = { ...payload };
  for (const [claimName, entry] of Object.entries(requested)) {
    if (ID_TOKEN_OWN_CLAIMS.has(claimName)) continue;
    if (!allowedClaimNames.has(claimName)) continue;
    if (Object.prototype.hasOwnProperty.call(result, claimName)) continue;
    // エンドユーザーのクレームのオブジェクト自身が持つプロパティだけを読み、継承したプロパティ（`constructor`、`toString` など）は読まない。
    if (!Object.prototype.hasOwnProperty.call(userClaims, claimName)) continue;

    const value = (userClaims as unknown as Record<string, unknown>)[claimName];
    if (value === undefined || value === null) continue;
    if (!matchesRequestedClaimValue(value, entry)) continue;

    result[claimName] = value;
  }
  return result;
}
