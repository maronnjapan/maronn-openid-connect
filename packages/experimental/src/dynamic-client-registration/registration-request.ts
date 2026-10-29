/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — 登録リクエストの解析と
 * メタデータの検証。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * §3.1: 登録リクエストのボディは application/json の JSON オブジェクト。
 * Content-Type の検査は HTTP を知る生成コード側の責務で、ここはパース前の
 * ボディ文字列を受け取る。処理は責務ごとの関数に分かれている。
 *
 * 1. parseClientRegistrationBody: ボディ長・JSON・オブジェクト形式の検査。
 *    software_statement（RFC 7591 §2.3）を平文のメタデータから切り離す
 * 2. （software-statement.ts）OP の設定に渡した検証関数で statement を検証し、
 *    applySoftwareStatement で主張されたメタデータを平文の値へ優先して重ねる
 * 3. validateClientMetadata: 理解するフィールドの値検査と既定値の適用、
 *    grant_types と response_types の整合検査、カスタムメタデータの検証
 *
 * validateClientRegistrationRequest は 1 と 3 を直結した短縮形で、
 * software_statement は検証せず無視する（RFC 7591 §3.1.1 は対応しない AS が
 * 無視することを許す）。
 */

import {
  normalizeResponseType,
  responseTypeIncludes,
  validateRegisteredRedirectUris,
  type JwkSet,
} from '@maronn-openid-connect/core';
import {
  defineOwnProperty,
  isJsonObject,
  validateApplicationType,
  validateContacts,
  validateDefaultMaxAge,
  validateDisplayString,
  validateHttpUrl,
  validateJwks,
  validateRedirectUrisForApplicationType,
  validateScope,
  validateSigningAlg,
} from './metadata-values.js';
import { ClientRegistrationError } from './registration-error.js';

/** parseClientRegistrationBody が読み取った登録リクエスト。 */
export interface ParsedClientRegistration {
  /** 平文の JSON メタデータ。software_statement は含まない。 */
  metadata: Record<string, unknown>;
  /** リクエストが software_statement メンバーを持っていたときの、その JWT 文字列。 */
  softwareStatement?: string;
}

export interface ParseClientRegistrationBodyOptions {
  /**
   * ボディ（パース前の文字列）の UTF-8 バイト長の上限。既定 16384。
   * 文字列長（UTF-16 コード単位数）ではなく TextEncoder で得たバイト長で
   * 判定し、多バイト文字を含む境界値テストを決定的にする。
   */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 16384;

/**
 * 登録リクエストボディ（文字列）を読み取る。
 *
 * ボディ長、JSON 構文、オブジェクト形式を検査し、software_statement メンバー
 * （RFC 7591 §3.1.1 は JWT の文字列と定める。文字列でなければ
 * invalid_software_statement）を平文のメタデータから切り離して返す。文字列の
 * 中身は見ない。検証は OP の設定に渡した関数の責務である。返す metadata は
 * パース結果そのものではなく、software_statement 以外の自身のプロパティを
 * 選び取った新しいオブジェクトである。
 */
export function parseClientRegistrationBody(
  rawBody: string,
  options?: ParseClientRegistrationBodyOptions,
): ParsedClientRegistration {
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
    throw new ClientRegistrationError('invalid_client_metadata', 'request body must be valid JSON');
  }
  if (!isJsonObject(parsed)) {
    throw new ClientRegistrationError('invalid_client_metadata', 'request body must be a JSON object');
  }

  const metadata: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name === 'software_statement') continue;
    defineOwnProperty(metadata, name, value);
  }
  const softwareStatement = parsed['software_statement'];
  if (softwareStatement === undefined) {
    return { metadata };
  }
  if (typeof softwareStatement !== 'string') {
    throw new ClientRegistrationError('invalid_software_statement', 'software_statement must be a string');
  }
  return { metadata, softwareStatement };
}

/**
 * カスタムメタデータ 1 項目の検証関数。
 *
 * リクエストの値（無ければ undefined）とリクエストの全メタデータを受け取り、
 * 登録する値を返す。undefined を返した項目は登録しない（省略時の既定値を
 * 返せば、既定値として登録される）。拒否するときは ClientRegistrationError を
 * 投げる。返した値は登録メタデータとして 201 応答に現れる。
 */
export type CustomClientMetadataValidator = (
  value: unknown,
  metadata: Readonly<Record<string, unknown>>,
) => unknown;

export interface ValidateClientMetadataOptions {
  /**
   * 登録できる token_endpoint_auth_method（RFC 7591 §2）。既定は core が検証
   * できる client_secret_basic / client_secret_post / none。private_key_jwt の
   * ように OP 側で認証手段を足した方式は、ここに加えて登録できるようにする。
   */
  tokenEndpointAuthMethods?: readonly string[];
  /**
   * 登録できる grant_type。既定は authorization_code と refresh_token。OP が
   * 答える grant（implicit、experimental grant の URN）はここで広げる。
   */
  grantTypes?: readonly string[];
  /**
   * 登録できる response_type（normalizeResponseType の形）。既定は code のみ。
   * Implicit Flow / Hybrid Flow を持つ OP は、discovery の response_types_supported
   * と同じ一覧を渡す。
   */
  responseTypes?: readonly string[];
  /**
   * 登録できる scope 値。省略時は構文（RFC 6749 §3.3）だけを検査し、どの値も
   * 受理する。
   */
  scopes?: readonly string[];
  /**
   * id_token_signed_response_alg に受理する alg。既定は RS256 のみ。省略時の
   * 既定値 RS256（OIDC Dynamic Client Registration 1.0 §2）もこの一覧に照合する
   * ので、RS256 で署名できない OP は省略した登録を拒否する。
   */
  idTokenSigningAlgValuesSupported?: readonly string[];
  /** userinfo_signed_response_alg に受理する alg。既定は RS256 のみ。 */
  userinfoSigningAlgValuesSupported?: readonly string[];
  /**
   * カスタムメタデータ。キーがメタデータ名、値がその検証関数。標準フィールド
   * （本モジュールが理解する名前）と同じ名前は設定の誤りとして TypeError になる。
   */
  customMetadata?: Readonly<Record<string, CustomClientMetadataValidator>>;
}

/**
 * 検証済み登録メタデータ（RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2
 * の既定値適用後）。
 */
export interface ValidatedClientRegistration {
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  responseTypes: string[];
  /** OIDC Dynamic Client Registration 1.0 §2 の application_type。省略時の既定は web。 */
  applicationType: 'web' | 'native';
  /** RFC 7591 §2 の scope。登録したときだけ持つ（core の ClientInfo.scope と同じ意味）。 */
  scope?: string[];
  /** OIDC Dynamic Client Registration 1.0 §2 の default_max_age。登録したときだけ持つ。 */
  defaultMaxAge?: number;
  /** OIDC Dynamic Client Registration 1.0 §2 の id_token_signed_response_alg。省略時の既定は RS256。 */
  idTokenSignedResponseAlg: string;
  /** userinfo_signed_response_alg。登録したときだけ持つ（無ければ UserInfo は署名しない JSON）。 */
  userinfoSignedResponseAlg?: string;
  /** RFC 7591 §2 の jwks（正規化済み）。登録したときだけ持つ。 */
  jwks?: JwkSet;
  /**
   * 登録した全メタデータの RFC 7591 のワイヤ形式（スネークケース）。既定値の
   * 適用後の値、software_statement、カスタムメタデータを含み、201 応答の
   * 発行値以外のメンバーそのものになる。
   */
  metadata: Record<string, unknown>;
}

/** 本機能の既定で理解する auth method（RFC 7591 §2 のうち core が検証する secret 系と none）。 */
export const DEFAULT_TOKEN_ENDPOINT_AUTH_METHODS: readonly string[] = [
  'client_secret_basic',
  'client_secret_post',
  'none',
];

/** 既定で登録できる grant_type。 */
export const DEFAULT_GRANT_TYPES: readonly string[] = ['authorization_code', 'refresh_token'];

/** 既定で登録できる response_type。 */
export const DEFAULT_RESPONSE_TYPES: readonly string[] = ['code'];

const DEFAULT_SIGNING_ALGS: readonly string[] = ['RS256'];

/**
 * 本モジュールが理解するメタデータ名。カスタムメタデータの名前は、ここと
 * 重ならないことを validateClientMetadata が確かめる。
 */
export const STANDARD_CLIENT_METADATA_NAMES: readonly string[] = [
  'redirect_uris',
  'token_endpoint_auth_method',
  'grant_types',
  'response_types',
  'client_name',
  'client_uri',
  'logo_uri',
  'tos_uri',
  'policy_uri',
  'contacts',
  'scope',
  'software_id',
  'software_version',
  'application_type',
  'jwks',
  'jwks_uri',
  'default_max_age',
  'id_token_signed_response_alg',
  'userinfo_signed_response_alg',
  'software_statement',
];

const CLIENT_NAME_MAX_LENGTH = 128;
const SOFTWARE_ID_MAX_LENGTH = 128;
const SOFTWARE_VERSION_MAX_LENGTH = 64;

/**
 * 登録メタデータを検証し、既定値を適用して返す。
 *
 * 既定値は RFC 7591 §2（token_endpoint_auth_method、grant_types、response_types）と
 * OIDC Dynamic Client Registration 1.0 §2（application_type、
 * id_token_signed_response_alg）のもので、AS が適用した既定値は応答に含めなければ
 * ならない（同 §3.2 MUST）ため、どれも登録メタデータ（metadata）に書き込む。
 *
 * 未知フィールドは黙って捨てる（RFC 7591 §2 MUST ignore）。実装は「理解する
 * フィールドだけを新しいオブジェクトへ選び取る」allowlist-pick 方式で、
 * パース結果のスプレッドや Object.assign によるコピーをしない。`__proto__`
 * などプロトタイプ経路のキーを持つ入力は、読まれないまま不活性に落ちる。
 *
 * metadata に software_statement があれば、それは検証済みの JWT として扱い
 * （applySoftwareStatement が置く）、応答へそのまま返す。
 *
 * 失敗時は ClientRegistrationError を投げる。
 */
export function validateClientMetadata(
  metadata: Readonly<Record<string, unknown>>,
  options?: ValidateClientMetadataOptions,
): ValidatedClientRegistration {
  const tokenEndpointAuthMethods = options?.tokenEndpointAuthMethods ?? DEFAULT_TOKEN_ENDPOINT_AUTH_METHODS;
  const grantTypesSupported = options?.grantTypes ?? DEFAULT_GRANT_TYPES;
  const responseTypesSupported = options?.responseTypes ?? DEFAULT_RESPONSE_TYPES;

  const redirectUris = validateRedirectUris(metadata['redirect_uris']);
  const tokenEndpointAuthMethod = validateTokenEndpointAuthMethod(
    metadata['token_endpoint_auth_method'],
    tokenEndpointAuthMethods,
  );
  const grantTypes = validateGrantTypes(metadata['grant_types'], grantTypesSupported);
  const responseTypes = validateResponseTypes(metadata['response_types'], responseTypesSupported);
  validateGrantAndResponseTypeConsistency(grantTypes, responseTypes);
  // OIDC Dynamic Client Registration 1.0 §2: application_type は省略時 web。
  // AS は登録するすべての redirect_uris がその種別の制約（web で implicit grant を
  // 使うなら https かつ localhost 以外、native ならカスタムスキームかループバックの
  // http）に従うことを確かめなければならない（MUST）ので、省略時も web として検査する。
  const applicationType = validateApplicationType(
    metadata['application_type'] === undefined ? 'web' : metadata['application_type'],
  );
  validateRedirectUrisForApplicationType(redirectUris, applicationType, grantTypes);
  // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg は省略時
  // RS256。既定値も OP が署名できる alg の一覧に照合する。
  const idTokenSignedResponseAlg = validateSigningAlg(
    metadata['id_token_signed_response_alg'] === undefined ? 'RS256' : metadata['id_token_signed_response_alg'],
    'id_token_signed_response_alg',
    options?.idTokenSigningAlgValuesSupported ?? DEFAULT_SIGNING_ALGS,
  );

  const registered: Record<string, unknown> = {
    redirect_uris: [...redirectUris],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    grant_types: [...grantTypes],
    response_types: [...responseTypes],
    application_type: applicationType,
  };
  const validated: ValidatedClientRegistration = {
    redirectUris,
    tokenEndpointAuthMethod,
    grantTypes,
    responseTypes,
    applicationType,
    idTokenSignedResponseAlg,
    metadata: registered,
  };

  if (metadata['client_name'] !== undefined) {
    registered['client_name'] = validateDisplayString(metadata['client_name'], 'client_name', CLIENT_NAME_MAX_LENGTH);
  }
  for (const name of ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri']) {
    if (metadata[name] !== undefined) {
      registered[name] = validateHttpUrl(metadata[name], name);
    }
  }
  if (metadata['contacts'] !== undefined) {
    registered['contacts'] = validateContacts(metadata['contacts']);
  }
  if (metadata['scope'] !== undefined) {
    const scope = validateScope(metadata['scope'], options?.scopes);
    validated.scope = scope;
    registered['scope'] = scope.join(' ');
  }
  if (metadata['software_id'] !== undefined) {
    registered['software_id'] = validateDisplayString(metadata['software_id'], 'software_id', SOFTWARE_ID_MAX_LENGTH);
  }
  if (metadata['software_version'] !== undefined) {
    registered['software_version'] = validateDisplayString(
      metadata['software_version'],
      'software_version',
      SOFTWARE_VERSION_MAX_LENGTH,
    );
  }
  if (metadata['jwks'] !== undefined && metadata['jwks_uri'] !== undefined) {
    // RFC 7591 §2: jwks_uri と jwks を同時に使ってはならない。jwks_uri 単独は
    // この OP が取得しに行かない（理解しない）メタデータとして無視する。
    throw new ClientRegistrationError('invalid_client_metadata', 'jwks and jwks_uri must not both be present');
  }
  if (metadata['jwks'] !== undefined) {
    const jwks = validateJwks(metadata['jwks']);
    validated.jwks = jwks;
    registered['jwks'] = { keys: jwks.keys.map((key) => ({ ...key })) };
  }
  if (metadata['default_max_age'] !== undefined) {
    const defaultMaxAge = validateDefaultMaxAge(metadata['default_max_age']);
    validated.defaultMaxAge = defaultMaxAge;
    registered['default_max_age'] = defaultMaxAge;
  }
  registered['id_token_signed_response_alg'] = idTokenSignedResponseAlg;
  if (metadata['userinfo_signed_response_alg'] !== undefined) {
    const alg = validateSigningAlg(
      metadata['userinfo_signed_response_alg'],
      'userinfo_signed_response_alg',
      options?.userinfoSigningAlgValuesSupported ?? DEFAULT_SIGNING_ALGS,
    );
    validated.userinfoSignedResponseAlg = alg;
    registered['userinfo_signed_response_alg'] = alg;
  }
  if (metadata['software_statement'] !== undefined) {
    // RFC 7591 §3.2.1: 登録に使った software_statement は、そのまま応答に返す。
    const softwareStatement = metadata['software_statement'];
    if (typeof softwareStatement !== 'string') {
      throw new ClientRegistrationError('invalid_software_statement', 'software_statement must be a string');
    }
    registered['software_statement'] = softwareStatement;
  }

  for (const [name, validate] of Object.entries(options?.customMetadata ?? {})) {
    if (STANDARD_CLIENT_METADATA_NAMES.includes(name)) {
      throw new TypeError(`custom client metadata must not redefine the standard field ${name}`);
    }
    const value = validate(metadata[name], metadata);
    if (value !== undefined) {
      defineOwnProperty(registered, name, value);
    }
  }

  return validated;
}

export interface ValidateClientRegistrationOptions
  extends ParseClientRegistrationBodyOptions,
    ValidateClientMetadataOptions {}

/**
 * 登録リクエストボディ（文字列）を検証し、既定値を適用して返す短縮形。
 *
 * parseClientRegistrationBody と validateClientMetadata を直結し、
 * software_statement は検証せずに無視する（RFC 7591 §3.1.1）。software statement
 * を受け付ける OP は、両関数の間に設定の検証関数と applySoftwareStatement
 * （software-statement.ts）を挟む。
 */
export function validateClientRegistrationRequest(
  rawBody: string,
  options?: ValidateClientRegistrationOptions,
): ValidatedClientRegistration {
  const { metadata } = parseClientRegistrationBody(rawBody, options);
  return validateClientMetadata(metadata, options);
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
  if (!Array.isArray(value) || value.length === 0 || !value.every((uri) => typeof uri === 'string')) {
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
function validateTokenEndpointAuthMethod(value: unknown, supported: readonly string[]): string {
  if (value === undefined) {
    return 'client_secret_basic';
  }
  if (typeof value !== 'string' || !supported.includes(value)) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      `token_endpoint_auth_method must be one of ${supported.join(', ')}`,
    );
  }
  return value;
}

/**
 * grant_types: OPTIONAL、既定 ["authorization_code"]（RFC 7591 §2）。
 * supported に無い値は拒否する。重複は 1 つに正規化し、出現順を保つ。
 */
function validateGrantTypes(value: unknown, supported: readonly string[]): string[] {
  if (value === undefined) {
    return ['authorization_code'];
  }
  if (!Array.isArray(value) || !value.every((grantType) => typeof grantType === 'string' && supported.includes(grantType))) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      `grant_types must be an array containing only ${supported.join(', ')}`,
    );
  }
  return [...new Set(value as string[])];
}

/**
 * response_types: OPTIONAL、既定 ["code"]（RFC 7591 §2）。値は空白区切りで
 * 順序を問わないので（OAuth 2.0 Multiple Response Type Encoding Practices §1.2）、
 * core の normalizeResponseType で並べ直してから supported と照合し、重複を
 * 1 つに正規化する。
 */
function validateResponseTypes(value: unknown, supported: readonly string[]): string[] {
  if (value === undefined) {
    return ['code'];
  }
  const normalizedSupported = supported.map((responseType) => normalizeResponseType(responseType));
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (responseType) =>
        typeof responseType === 'string' && normalizedSupported.includes(normalizeResponseType(responseType)),
    )
  ) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      `response_types must be a non-empty array containing only ${normalizedSupported.join(', ')}`,
    );
  }
  return [...new Set((value as string[]).map((responseType) => normalizeResponseType(responseType)))];
}

/**
 * RFC 7591 §2.1 / OIDC Dynamic Client Registration 1.0 §2: grant_types と
 * response_types の対応。code を含む response_type は authorization_code grant を、
 * token か id_token を含む response_type は implicit grant を要し、逆に登録した
 * これらの grant には対応する response_type が要る。矛盾した登録は
 * invalid_client_metadata で拒否し、使えない組み合わせを登録させない（§2.1 SHOULD）。
 */
function validateGrantAndResponseTypeConsistency(grantTypes: readonly string[], responseTypes: readonly string[]): void {
  const usesCode = responseTypes.some((responseType) => responseTypeIncludes(responseType, 'code'));
  const usesImplicit = responseTypes.some(
    (responseType) => responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token'),
  );
  const consistent =
    usesCode === grantTypes.includes('authorization_code') && usesImplicit === grantTypes.includes('implicit');
  if (!consistent) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'grant_types and response_types must be consistent: code requires authorization_code, token and id_token require implicit',
    );
  }
}
