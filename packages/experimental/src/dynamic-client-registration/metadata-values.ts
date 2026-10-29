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

import type { Jwk, JwkSet } from '@maronn-openid-connect/core';
import { ClientRegistrationError } from './registration-error.js';

/**
 * 表示名や連絡先に登録させない文字。C0 / C1 制御文字と DEL、bidi 制御文字
 * （U+200E–U+200F / U+202A–U+202E / U+2066–U+2069）、ゼロ幅文字
 * （U+200B–U+200D / U+FEFF）。改行やエスケープでログや画面を汚す値に加え、
 * 表示順の反転や見えない文字で表示名を偽装する値も登録させない。
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/** JSON オブジェクト（配列と null を除く）か。 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 自身のデータプロパティとして値を置く。`target[name] = value` は name が
 * `__proto__` のときプロトタイプを差し替えてしまうので、リクエスト由来の名前で
 * オブジェクトを組み立てるときはこちらを使う。
 */
export function defineOwnProperty(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

function invalidMetadata(description: string): ClientRegistrationError {
  return new ClientRegistrationError('invalid_client_metadata', description);
}

/**
 * 人間が読む文字列のメタデータ（client_name / software_id / software_version /
 * contacts の各要素）。長さの上限と、制御文字や見えない文字の不在だけを検査する。
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
 * 利用者へ示す URL のメタデータ（client_uri / logo_uri / tos_uri / policy_uri。
 * RFC 7591 §2）。OP はこれらを取得しに行かず、保持して応答に返すだけなので、
 * 検査は絶対 URL であることと http / https スキームに限る。`javascript:` などの
 * スキームは、将来この値を画面へ出すときのために登録段階で拒否する。
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

const CONTACTS_MAX_ENTRIES = 32;
const CONTACT_MAX_LENGTH = 256;

/**
 * contacts: 責任者への連絡手段（通常はメールアドレス）の配列（RFC 7591 §2）。
 * メールアドレスの構文は検査しない（RFC 7591 は形式を定めず、OP は送信しない）。
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
 * scope: クライアントが要求してよい scope 値のスペース区切り文字列（RFC 7591 §2）。
 * 構文（RFC 6749 §3.3）を検査し、重複を 1 つに正規化した配列で返す。
 * supportedScopes があれば、一覧に無い値は拒否する。
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
 * application_type: web または native（OIDC Dynamic Client Registration 1.0 §2）。
 */
export function validateApplicationType(value: unknown): 'web' | 'native' {
  if (value !== 'web' && value !== 'native') {
    throw invalidMetadata('application_type must be web or native');
  }
  return value;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * OIDC Dynamic Client Registration 1.0 §2 が application_type ごとに redirect_uris へ
 * 課す制約。
 *
 * - native: カスタム URI スキームか、http スキームのループバック URL
 *   （localhost / 127.0.0.1 / [::1]）だけを登録できる
 * - web かつ implicit grant を使う: https スキームだけを登録でき、ホスト名に
 *   localhost を使えない
 *
 * application_type を省略した登録には、core の規則（validateRegisteredRedirectUris）
 * だけが掛かる。
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
 * default_max_age: 秒数を表す非負整数（OIDC Dynamic Client Registration 1.0 §2）。
 * core の validateDefaultMaxAge と同じ規則で、登録段階で拒否する。
 */
export function validateDefaultMaxAge(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidMetadata('default_max_age must be a non-negative integer');
  }
  return value;
}

/**
 * id_token_signed_response_alg / userinfo_signed_response_alg: OP が署名できる
 * アルゴリズムの一覧（通常は登録済み鍵から導いた値）に含まれる値だけを受理する。
 * none は受理しない（OIDC Dynamic Client Registration 1.0 §2）。
 */
export function validateSigningAlg(value: unknown, name: string, supported: readonly string[]): string {
  if (typeof value !== 'string' || value === 'none' || !supported.includes(value)) {
    throw invalidMetadata(`${name} must be one of ${supported.join(', ')}`);
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
 * jwks: クライアントの公開鍵の JWK Set（RFC 7591 §2）。OP は署名検証にだけ使うので、
 * core が読める RSA / EC の署名用公開鍵に限る。秘密鍵パラメータを持つ鍵は拒否する。
 *
 * 返す鍵は理解するメンバーだけを選び取った新しいオブジェクトで、alg と use が無い
 * 鍵には既定（RSA は RS256、EC は曲線に対応する ES*、use は sig）を補う。
 * 補った値は登録メタデータとして応答に現れる（RFC 7591 §3.1 の「置換してよい」）。
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
