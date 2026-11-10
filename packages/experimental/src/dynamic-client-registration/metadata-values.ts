/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — 個々のメタデータ値の検査。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * registration-request.ts の validateClientMetadata が、理解するフィールドごとに
 * ここの関数を呼ぶ。どの関数も値の形だけを見る純関数で、違反は
 * ClientRegistrationError（invalid_client_metadata）として投げる。
 * error_description は固定の ASCII 文言に限り、リクエスト由来の値を埋め込まない。
 */

import { validateClientJwksUri, type Jwk, type JwkSet } from '@maronn-openid-connect/core';
import { ClientRegistrationError } from './registration-error.js';

/**
 * 表示名や連絡先に登録させない文字。C0 / C1 制御文字と DEL、bidi 制御文字
 * （U+200E–U+200F / U+202A–U+202E / U+2066–U+2069）、ゼロ幅文字
 * （U+200B–U+200D / U+FEFF）。改行やエスケープでログや画面を汚す値に加え、
 * 表示順の反転や見えない文字で表示名を偽装する値も登録させない。
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/**
 * 値が JSON オブジェクトなら true を返す。
 *
 * 配列と `null` は JSON オブジェクトとみなさない。
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `target` に `name` の値を自身のプロパティとして置く。
 *
 * プロパティは、列挙でき、書き換えられ、定義し直せるデータプロパティにする。
 * `target[name] = value` と書くと、`name` が `__proto__` のときにプロトタイプを差し替えてしまうので、リクエストから来た名前でオブジェクトを組み立てるときはこの関数を使う。
 */
export function defineOwnProperty(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `invalid_client_metadata` の登録エラーを作って返す。
 *
 * `description` を `error_description` にした `ClientRegistrationError` を作り、投げずに返す。
 */
function invalidMetadata(description: string): ClientRegistrationError {
  return new ClientRegistrationError('invalid_client_metadata', description);
}

/**
 * 表示用の文字列を検証し、そのまま返す。
 *
 * 人が読む文字列のメタデータ（`client_name`、`software_id`、`software_version`、`contacts` の各要素）に使う。
 * 文字列でないとき、長さが `maxLength` を超えるとき、制御文字や見えない文字（表示の向きを変える文字、ゼロ幅の文字）を含むときは、`invalid_client_metadata` を投げる。
 * 確かめるのはこの 3 つだけである。
 *
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき。
 */
export function validateDisplayString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw invalidMetadata(`${name} must be a string`);
  }
  if (value.length > maxLength) {
    throw invalidMetadata(`${name} must be at most ${maxLength} characters`);
  }
  if (INVISIBLE_CHARACTERS.test(value)) {
    throw invalidMetadata(`${name} must not contain control or invisible formatting characters`);
  }
  return value;
}

const URL_MAX_LENGTH = 2048;

/**
 * HTTP か HTTPS の絶対 URL を検証し、そのまま返す。
 *
 * 利用者に示す URL のメタデータ（`client_uri`、`logo_uri`、`tos_uri`、`policy_uri`）に使う（RFC 7591 §2）。
 * 文字列でないとき、空文字列のとき、2048 文字を超えるとき、制御文字や見えない文字を含むとき、URL として解析できないとき、スキームが `http` と `https` 以外のときは、`invalid_client_metadata` を投げる。
 *
 * OP はこれらの URL を取得しに行かず、保持してレスポンスで返すだけなので、検証は絶対 URL であることとスキームに限る。
 * `javascript:` などのスキームは、将来この値を画面に表示するときに備えて、登録の段階で拒否する。
 *
 * @spec RFC 7591 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき。
 */
export function validateHttpUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX_LENGTH) {
    throw invalidMetadata(`${name} must be an absolute http or https URL`);
  }
  if (INVISIBLE_CHARACTERS.test(value)) {
    throw invalidMetadata(`${name} must be an absolute http or https URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidMetadata(`${name} must be an absolute http or https URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidMetadata(`${name} must be an absolute http or https URL`);
  }
  return value;
}

const REQUEST_URIS_MAX_ENTRIES = 32;
const REQUEST_URIS_DESCRIPTION = 'request_uris must be an array of 1 to 32 absolute https URLs';
const INSECURE_REQUEST_URIS_DESCRIPTION = 'request_uris must be an array of 1 to 32 absolute http or https URLs';

/**
 * `request_uris`（クライアントが `request_uri` に使う URL の一覧）を検証し、同じ値の新しい配列を返す。
 *
 * 各要素は空白と制御文字を含まない絶対 URL で、スキームは `https` でなければならない（`allowInsecure` のときは `http` も通す）。
 * URL はフラグメントを含んでよい（OIDC Dynamic Client Registration 1.0 §2。フラグメントは中身のハッシュなどを表し、取得のときに除く）。
 * 配列でないとき、空のとき、32 個を超えるとき、要素のどれかが 2048 文字を超えるか上の条件に合わないときは、`invalid_client_metadata` を投げる。
 * 登録の時点では取得しない。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec OIDC Core 1.0 §6.2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき。
 */
export function validateRequestUris(value: unknown, allowInsecure: boolean): string[] {
  const description = allowInsecure ? INSECURE_REQUEST_URIS_DESCRIPTION : REQUEST_URIS_DESCRIPTION;
  if (!Array.isArray(value) || value.length === 0 || value.length > REQUEST_URIS_MAX_ENTRIES) {
    throw invalidMetadata(description);
  }
  for (const uri of value) {
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > URL_MAX_LENGTH || INVISIBLE_CHARACTERS.test(uri) || /\s/.test(uri)) {
      throw invalidMetadata(description);
    }
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw invalidMetadata(description);
    }
    if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
      throw invalidMetadata(description);
    }
  }
  return [...(value as string[])];
}

const CONTACTS_MAX_ENTRIES = 32;
const CONTACT_MAX_LENGTH = 256;

/**
 * `contacts` を検証し、文字列の配列を返す。
 *
 * `contacts` は、クライアントの責任者への連絡先（通常はメールアドレス）の配列である（RFC 7591 §2）。
 * 配列でないとき、空のとき、32 個を超えるときは、`invalid_client_metadata` を投げる。
 * 各要素は {@link validateDisplayString} で、256 文字以下の文字列であることなどを確かめる。
 *
 * メールアドレスの構文は確かめない。
 * RFC 7591 は形式を定めておらず、OP はこの連絡先にメールを送らないからである。
 *
 * @spec RFC 7591 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき、または要素のどれかが {@link validateDisplayString} の検証に失敗したとき。
 */
export function validateContacts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CONTACTS_MAX_ENTRIES) {
    throw invalidMetadata(`contacts must be an array of 1 to ${CONTACTS_MAX_ENTRIES} strings`);
  }
  return value.map((contact) => validateDisplayString(contact, 'each contact', CONTACT_MAX_LENGTH));
}

/**
 * RFC 6749 §3.3: scope = scope-token *( SP scope-token )、
 * scope-token = 1*( %x21 / %x23-5B / %x5D-7E )。二重引用符とバックスラッシュ、
 * 空白、制御文字は使えない。
 */
const SCOPE_SYNTAX = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;

/**
 * `scope` を検証し、重複を除いた値の配列を返す。
 *
 * `scope` は、クライアントが要求してよいスコープを空白で区切った文字列である（RFC 7591 §2）。
 * 文字列でないとき、構文（RFC 6749 §3.3）に合わないとき、`supportedScopes` を渡していてそこにない値を含むときは、`invalid_client_metadata` を投げる。
 * 構文では、値の区切りは半角空白 1 つだけで、値に二重引用符、バックスラッシュ、制御文字は使えない。
 *
 * @spec RFC 7591 §2
 * @spec RFC 6749 §3.3
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき。
 */
export function validateScope(value: unknown, supportedScopes: readonly string[] | undefined): string[] {
  if (typeof value !== 'string') {
    throw invalidMetadata('scope must be a space-delimited string of scope values');
  }
  if (!SCOPE_SYNTAX.test(value)) {
    throw invalidMetadata('scope must be a space-delimited string of scope values');
  }
  const scopes = [...new Set(value.split(' '))];
  if (supportedScopes !== undefined && scopes.some((scope) => !supportedScopes.includes(scope))) {
    throw invalidMetadata('scope must contain only scope values this provider supports');
  }
  return scopes;
}

/**
 * `application_type` を検証し、そのまま返す。
 *
 * 値が `web` か `native` でなければ、`invalid_client_metadata` を投げる（OIDC Dynamic Client Registration 1.0 §2）。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: `web` と `native` 以外の値のとき。
 */
export function validateApplicationType(value: unknown): 'web' | 'native' {
  if (value !== 'web' && value !== 'native') {
    throw invalidMetadata('application_type must be web or native');
  }
  return value;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * リダイレクト URI がアプリの種別に合うか確かめる。
 *
 * OIDC Dynamic Client Registration 1.0 §2 が `application_type` ごとに `redirect_uris` に課す次の制約を確かめ、合わない URI があれば `invalid_client_metadata` を投げる。
 * - `native`: カスタム URI スキームか、`http` スキームのループバックの URL（`localhost`、`127.0.0.1`、`[::1]`）だけを登録できる。
 * - `web` でグラントタイプ `implicit` を使う: `https` スキームだけを登録でき、ホスト名に `localhost` を使えない。
 *
 * `application_type` を省略した登録には、core の規則（`validateRegisteredRedirectUris()`）だけを適用する。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: `redirect_uris` のどれかが制約に合わないとき。
 */
export function validateRedirectUrisForApplicationType(
  redirectUris: readonly string[],
  applicationType: 'web' | 'native',
  grantTypes: readonly string[],
): void {
  if (applicationType === 'native') {
    for (const uri of redirectUris) {
      const url = new URL(uri);
      if (url.protocol === 'https:' || (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname))) {
        throw invalidMetadata(
          'a native client must register custom scheme or loopback http redirect_uris only',
        );
      }
    }
    return;
  }
  if (grantTypes.includes('implicit')) {
    for (const uri of redirectUris) {
      const url = new URL(uri);
      if (url.protocol !== 'https:' || url.hostname === 'localhost') {
        throw invalidMetadata(
          'a web client using the implicit grant must register https redirect_uris that do not use localhost',
        );
      }
    }
  }
}

/**
 * `default_max_age` を検証し、そのまま返す。
 *
 * 値が秒数を表す 0 以上の整数でなければ、`invalid_client_metadata` を投げる（OIDC Dynamic Client Registration 1.0 §2）。
 * core の `validateDefaultMaxAge()` と同じ規則を、登録の段階で適用する。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 0 以上の整数でないとき。
 */
export function validateDefaultMaxAge(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidMetadata('default_max_age must be a non-negative integer');
  }
  return value;
}

/**
 * 署名アルゴリズムのメタデータを検証し、そのまま返す。
 *
 * `id_token_signed_response_alg` と `userinfo_signed_response_alg` に使う。
 * 値が `supported`（OP が署名できるアルゴリズムの一覧で、通常は登録した鍵から求める）にある文字列のときだけ受け付け、それ以外は `invalid_client_metadata` を投げる。
 * `none` は受け付けない（OIDC Dynamic Client Registration 1.0 §2）。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 値が文字列でないとき、`none` のとき、または `supported` にないとき。
 */
export function validateSigningAlg(value: unknown, name: string, supported: readonly string[]): string {
  if (typeof value !== 'string' || value === 'none' || !supported.includes(value)) {
    throw invalidMetadata(`${name} must be one of ${supported.join(', ')}`);
  }
  return value;
}

const JWKS_URI_DESCRIPTION =
  'jwks_uri must be an absolute https URL without a fragment or userinfo that does not point to a loopback, private or link-local address';

/**
 * `jwks_uri`（クライアントの公開鍵の JWK Set を返す URL）を検証し、そのまま返す。
 *
 * 宛先の検査（`https` であること、フラグメントと userinfo がないこと、ループバック・私設・リンクローカルの IP リテラルと `localhost` でないこと）は core の `validateClientJwksUri()` に任せ、通らなければ固定の文言の `invalid_client_metadata` を投げる。
 * 文言には URI を埋め込まない。
 * `allowInsecure` が `true` のときは、`http` とそれらのアドレスも受け付ける（開発用）。
 *
 * 登録の時点では取得しない。中身は、生成コードが鍵を使うときに初めて取得する。
 * オープン登録の受け口を、そのまま外部への取得の引き金にしないためである。
 *
 * @spec RFC 7591 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 文字列でないとき、見えない文字を含むとき、または宛先の検査を通らないとき。
 */
export function validateJwksUri(value: unknown, allowInsecure: boolean): string {
  if (typeof value !== 'string' || INVISIBLE_CHARACTERS.test(value)) {
    throw invalidMetadata(JWKS_URI_DESCRIPTION);
  }
  try {
    return validateClientJwksUri(value, { allowInsecure });
  } catch {
    throw invalidMetadata(JWKS_URI_DESCRIPTION);
  }
}

/**
 * `request_object_signing_alg`（このクライアントがリクエストオブジェクトの署名に使う alg）を検証し、そのまま返す。
 *
 * 値が `supported`（OP が受け付ける alg の一覧。ディスカバリーの `request_object_signing_alg_values_supported` と同じもの）にある文字列のときだけ受け付け、それ以外は `invalid_client_metadata` を投げる。
 * {@link validateSigningAlg} と違い、一覧にあれば `none` も受け付ける（OIDC Dynamic Client Registration 1.0 §2 は `none` を使ってよいとしている）。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 値が文字列でないとき、または `supported` にないとき。
 */
export function validateRequestObjectSigningAlg(value: unknown, supported: readonly string[]): string {
  if (typeof value !== 'string' || !supported.includes(value)) {
    throw invalidMetadata(`request_object_signing_alg must be one of ${supported.join(', ')}`);
  }
  return value;
}

const JWKS_MAX_KEYS = 16;
const KID_MAX_LENGTH = 128;
/** JWK の秘密鍵パラメータ（RFC 7518 §6.2.2 / §6.3.2 / §6.4）。公開鍵の登録には現れない。 */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const RSA_ALGORITHMS = ['RS256', 'RS384', 'RS512'];
const EC_CURVE_ALGORITHMS: Record<string, string> = { 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512' };
const JWKS_DESCRIPTION =
  'jwks must be a JWK Set of 1 to 16 public RSA (RS256, RS384, RS512) or EC (P-256, P-384, P-521) signature keys';

/**
 * `jwks` を検証し、正規化した JWK Set を返す。
 *
 * `jwks` は、クライアントの公開鍵の JWK Set である（RFC 7591 §2）。
 * OP は署名の検証にだけ使うので、core が読める RSA と EC の署名用の公開鍵に限り、秘密鍵のパラメータを持つ鍵は拒否する。
 * JSON オブジェクトでないとき、`keys` が配列でないとき、鍵が 0 個か 17 個以上のときは、`invalid_client_metadata` を投げる。
 * 鍵ごとの検証は `validateJwk()` で行う。
 *
 * 返す鍵は、理解するメンバーだけを選び取った新しいオブジェクトで、`alg` と `use` がない鍵には既定値（`alg` は RSA なら `RS256`、EC なら曲線に対応する `ES256` などで、`use` は `sig`）を補う。
 * 補った値は、登録したメタデータとしてレスポンスに現れる（RFC 7591 §3.1 が認める置き換え）。
 *
 * @spec RFC 7591 §2
 * @spec RFC 7591 §3.1
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき、または鍵のどれかが `validateJwk()` の検証に失敗したとき。
 */
export function validateJwks(value: unknown): JwkSet {
  if (!isJsonObject(value) || !Array.isArray(value['keys'])) {
    throw invalidMetadata(JWKS_DESCRIPTION);
  }
  const keys = value['keys'];
  if (keys.length === 0 || keys.length > JWKS_MAX_KEYS) {
    throw invalidMetadata(JWKS_DESCRIPTION);
  }
  return { keys: keys.map((key) => validateJwk(key)) };
}

/**
 * JWK Set の鍵 1 つを検証し、正規化した JWK を返す。
 *
 * 鍵が RSA か EC の署名用の公開鍵であることを確かめ、理解するメンバーだけを選び取った新しい JWK を返す。
 * 返す鍵の `use` は常に `sig` で、`alg` がなければ RSA には `RS256` を、EC には曲線に対応する `ES256`、`ES384`、`ES512` を補う。
 * それ以外のメンバー（`x5c` など）は捨てる。
 *
 * 次のどれかに当たる値には、`invalid_client_metadata` を投げる。
 * - JSON オブジェクトでない、または `kty` が `RSA` と `EC` 以外である。
 * - 秘密鍵のパラメータ（`d`、`p`、`q`、`dp`、`dq`、`qi`、`oth`、`k`）を持つ。
 * - `use` が `sig` 以外である。
 * - `kid` が 128 文字以下の文字列でないか、制御文字や見えない文字を含む。
 * - `alg` が文字列でないか、鍵の種類や曲線に合わない（RSA に使えるのは `RS256`、`RS384`、`RS512`）。
 * - RSA の `n` と `e`、または EC の `crv`、`x`、`y` が文字列でない。
 * - 曲線が `P-256`、`P-384`、`P-521` 以外である。
 *
 * @spec RFC 7591 §2
 * @spec RFC 7518 §6.2 / §6.3
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 上のどれかに当たるとき。
 */
function validateJwk(value: unknown): Jwk {
  if (!isJsonObject(value) || (value['kty'] !== 'RSA' && value['kty'] !== 'EC')) {
    throw invalidMetadata(JWKS_DESCRIPTION);
  }
  if (PRIVATE_JWK_MEMBERS.some((member) => member in value)) {
    throw invalidMetadata('jwks must contain public keys only');
  }
  const use = value['use'];
  if (use !== undefined && use !== 'sig') {
    throw invalidMetadata(JWKS_DESCRIPTION);
  }
  const kid = value['kid'];
  if (kid !== undefined) {
    validateDisplayString(kid, 'kid of a jwks key', KID_MAX_LENGTH);
  }
  const alg = value['alg'];
  if (alg !== undefined && typeof alg !== 'string') {
    throw invalidMetadata(JWKS_DESCRIPTION);
  }
  const common = { ...(kid === undefined ? {} : { kid: kid as string }), use: 'sig' };

  if (value['kty'] === 'RSA') {
    const n = value['n'];
    const e = value['e'];
    if (typeof n !== 'string' || typeof e !== 'string') {
      throw invalidMetadata(JWKS_DESCRIPTION);
    }
    const rsaAlg = alg ?? 'RS256';
    if (!RSA_ALGORITHMS.includes(rsaAlg)) {
      throw invalidMetadata(JWKS_DESCRIPTION);
    }
    return { kty: 'RSA', ...common, alg: rsaAlg, n, e };
  }

  if (value['kty'] === 'EC') {
    const crv = value['crv'];
    const x = value['x'];
    const y = value['y'];
    if (typeof crv !== 'string' || typeof x !== 'string' || typeof y !== 'string') {
      throw invalidMetadata(JWKS_DESCRIPTION);
    }
    const curveAlg = EC_CURVE_ALGORITHMS[crv];
    if (curveAlg === undefined || (alg !== undefined && alg !== curveAlg)) {
      throw invalidMetadata(JWKS_DESCRIPTION);
    }
    return { kty: 'EC', ...common, alg: curveAlg, crv, x, y };
  }

  throw invalidMetadata(JWKS_DESCRIPTION);
}
