/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — 登録リクエストの検証。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * §3.1: 登録リクエストのボディは application/json の JSON オブジェクト。
 * Content-Type の検査は HTTP を知る生成コード側の責務で、ここはパース前の
 * ボディ文字列を受け取り、検証済みメタデータ（既定値適用後）を返す。
 */

import { validateRegisteredRedirectUris } from '@maronn-openid-connect/core';

/**
 * 検証エラー。error は RFC 7591 §3.2.2 のエラーコードで、HTTP 応答では
 * 400 の JSON ボディ（error / error_description）になる。
 *
 * errorDescription は固定の ASCII 文言に限り、リクエスト由来の値（URI や
 * メタデータ値）を決して埋め込まない。検証失敗の詳細を攻撃者の探索に
 * 使わせないため（仕様書のセキュリティ要件）。
 */
export class ClientRegistrationError extends Error {
  readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata';
  readonly errorDescription: string;

  constructor(
    error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    errorDescription: string,
  ) {
    super(errorDescription);
    this.name = 'ClientRegistrationError';
    this.error = error;
    this.errorDescription = errorDescription;
  }
}

/** 検証済み登録メタデータ（RFC 7591 §2 の既定値適用後）。 */
export interface ValidatedClientRegistration {
  redirectUris: string[];
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'none';
  grantTypes: string[];
  responseTypes: string[];
  clientName?: string;
}

export interface ValidateClientRegistrationOptions {
  /**
   * ボディ（パース前の文字列）の UTF-8 バイト長の上限。既定 16384。
   * 文字列長（UTF-16 コード単位数）ではなく TextEncoder で得たバイト長で
   * 判定し、多バイト文字を含む境界値テストを決定的にする。
   */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 16384;

/** 本機能が理解する auth method（RFC 7591 §2 のうち secret 系と none）。 */
const SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'none',
] as const;

/**
 * 動的登録で許す grant_type。experimental grant の URN（token-exchange /
 * device / CIBA など）は登録させず、機能間の結合を作らない（仕様書の非目標）。
 */
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/**
 * 登録リクエストボディ（文字列）を検証し、既定値を適用して返す。
 *
 * 未知フィールドは黙って捨てる（RFC 7591 §2 MUST ignore）。実装は「理解する
 * 5 フィールドだけを新しいオブジェクトへ選び取る」allowlist-pick 方式で、
 * パース結果のスプレッドや Object.assign によるコピーをしない。`__proto__`
 * などプロトタイプ経路のキーを持つ入力は、読まれないまま不活性に落ちる。
 *
 * 失敗時は ClientRegistrationError を投げる。
 */
export function validateClientRegistrationRequest(
  rawBody: string,
  options?: ValidateClientRegistrationOptions,
): ValidatedClientRegistration {
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (new TextEncoder().encode(rawBody).length > maxBodyBytes) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'request body must not exceed the configured maximum size',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'request body must be valid JSON',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'request body must be a JSON object',
    );
  }
  const metadata = parsed as Record<string, unknown>;

  return {
    redirectUris: validateRedirectUris(metadata['redirect_uris']),
    tokenEndpointAuthMethod: validateTokenEndpointAuthMethod(
      metadata['token_endpoint_auth_method'],
    ),
    grantTypes: validateGrantTypes(metadata['grant_types']),
    responseTypes: validateResponseTypes(metadata['response_types']),
    ...pickClientName(metadata['client_name']),
  };
}

/**
 * redirect_uris は REQUIRED（OIDC Dynamic Client Registration 1.0 §2）。
 * URI の規則そのもの（フラグメント禁止・危険スキーム拒否・非ループバック
 * 平文 http 拒否。ネイティブアプリ向けのカスタムスキームは通る）は core の
 * validateRegisteredRedirectUris に委ね、静的クライアントと同一の登録基準を
 * 適用する。core の例外は違反 URI をメッセージへ埋め込んだ server_error
 * なので、コードを invalid_redirect_uri（RFC 7591 §3.2.2）へ、文言を URI を
 * 含まない固定 ASCII へ差し替える。
 */
function validateRedirectUris(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((uri) => typeof uri === 'string')
  ) {
    throw new ClientRegistrationError(
      'invalid_redirect_uri',
      'redirect_uris must be a non-empty array of strings',
    );
  }
  try {
    validateRegisteredRedirectUris(value);
  } catch {
    throw new ClientRegistrationError(
      'invalid_redirect_uri',
      'each redirect_uri must be an absolute URI without a fragment and must not use a dangerous scheme or non-loopback http',
    );
  }
  return [...value];
}

/** token_endpoint_auth_method: OPTIONAL、既定 client_secret_basic（RFC 7591 §2）。 */
function validateTokenEndpointAuthMethod(
  value: unknown,
): 'client_secret_basic' | 'client_secret_post' | 'none' {
  if (value === undefined) {
    return 'client_secret_basic';
  }
  const supported = SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.find(
    (method) => method === value,
  );
  if (!supported) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'token_endpoint_auth_method must be one of client_secret_basic, client_secret_post, none',
    );
  }
  return supported;
}

/**
 * grant_types: OPTIONAL、既定 ["authorization_code"]（RFC 7591 §2）。
 * response_types を ["code"] に固定する本機能では、code に対応する
 * authorization_code を含まない登録は §2.1 の inconsistent state に当たる
 * ため、refresh_token 単独は拒否する。重複は正規化して 1 つにする。
 */
function validateGrantTypes(value: unknown): string[] {
  if (value === undefined) {
    return ['authorization_code'];
  }
  if (
    !Array.isArray(value) ||
    !value.every((grantType) =>
      (SUPPORTED_GRANT_TYPES as readonly string[]).includes(grantType as string),
    )
  ) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'grant_types must be an array containing only authorization_code and refresh_token',
    );
  }
  const requested = new Set(value as string[]);
  if (!requested.has('authorization_code')) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'grant_types must include authorization_code',
    );
  }
  return SUPPORTED_GRANT_TYPES.filter((grantType) => requested.has(grantType));
}

/** response_types: OPTIONAL、既定 ["code"]（RFC 7591 §2）。code 以外は受理しない。 */
function validateResponseTypes(value: unknown): string[] {
  if (value === undefined) {
    return ['code'];
  }
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'code') {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'response_types must be exactly ["code"]',
    );
  }
  return ['code'];
}

const CLIENT_NAME_MAX_LENGTH = 128;

/**
 * client_name: OPTIONAL（RFC 7591 §2）。表示名なので長さと制御文字だけを
 * 検査する。省略時はキー自体を出さない（exactOptionalPropertyTypes 互換）。
 */
function pickClientName(value: unknown): { clientName?: string } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string') {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'client_name must be a string',
    );
  }
  if (value.length > CLIENT_NAME_MAX_LENGTH) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'client_name must be at most 128 characters',
    );
  }
  // C0 / C1 制御文字と DEL、bidi 制御文字（U+200E–U+200F / U+202A–U+202E /
  // U+2066–U+2069）、ゼロ幅文字（U+200B–U+200D / U+FEFF）。改行やエスケープで
  // ログ・画面を汚す値に加え、表示順の反転や見えない文字で表示名を偽装する
  // 値も登録させない。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(value)) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'client_name must not contain control or invisible formatting characters',
    );
  }
  return { clientName: value };
}
