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
  resolveJwkSigningAlg,
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
  validateJwksUri,
  validateRedirectUrisForApplicationType,
  validateRequestObjectSigningAlg,
  validateRequestUris,
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
 * 登録リクエストのボディを解析し、メタデータを返す。
 *
 * ボディ（解析前の文字列）の UTF-8 のバイト長が `maxBodyBytes`（既定は 16384）を超えるとき、JSON として解析できないとき、JSON オブジェクトでないときは、`invalid_client_metadata` を投げる。
 *
 * `software_statement` メンバーは、平文のメタデータから切り離して `softwareStatement` で返す。
 * RFC 7591 §3.1.1 は値を JWT の文字列と定めているので、文字列でなければ `invalid_software_statement` を投げる。
 * 文字列の中身は見ず、検証は OP の設定に渡した関数に任せる。
 *
 * 返す `metadata` は解析結果そのものではなく、`software_statement` 以外の自身のプロパティを選び取った新しいオブジェクトである。
 *
 * @spec RFC 7591 §3.1
 * @spec RFC 7591 §3.1.1
 * @throws {ClientRegistrationError} `invalid_client_metadata`: ボディが大きすぎるとき、JSON として解析できないとき、または JSON オブジェクトでないとき。
 * @throws {ClientRegistrationError} `invalid_software_statement`: `software_statement` が文字列でないとき。
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
   * jwks_uri（RFC 7591 §2）を登録するか。既定 true で、宛先を検査して登録し、201 応答に返す
   * （§2 は jwks より jwks_uri を勧める）。登録時には取得しない。jwks_uri を取得しない OP は
   * false を渡し、理解しないメタデータとして無視させる（§2 MUST ignore）。jwks との併記は、
   * この設定によらず拒否する。
   */
  acceptJwksUri?: boolean;
  /**
   * jwks_uri に http と、ループバック・私設・リンクローカルのアドレスと localhost を許す
   * （開発用）。既定 false。
   */
  allowInsecureJwksUri?: boolean;
  /**
   * request_object_signing_alg（OIDC Dynamic Client Registration 1.0 §2）に受理する alg。
   * discovery の request_object_signing_alg_values_supported と同じ一覧を渡す。省略時は
   * このメタデータを理解しないものとして無視する（Request Object を扱わない OP）。
   */
  requestObjectSigningAlgValuesSupported?: readonly string[];
  /**
   * token_endpoint_auth_signing_alg（OIDC Dynamic Client Registration 1.0 §2）に受理する alg。
   * discovery の token_endpoint_auth_signing_alg_values_supported と同じ一覧を渡す（none は
   * 渡しても受理しない）。省略時はこのメタデータを理解しないものとして無視する。
   */
  tokenEndpointAuthSigningAlgValuesSupported?: readonly string[];
  /**
   * request_uris（OIDC Dynamic Client Registration 1.0 §2）を登録するか。既定 false で、
   * request_uri を扱わない OP は理解しないメタデータとして無視する。true の OP は、各要素が
   * https の絶対 URL（フラグメント可）であることを確かめて登録する。
   */
  acceptRequestUris?: boolean;
  /** request_uris に http の URL を許す（開発用）。既定 false。 */
  allowInsecureRequestUris?: boolean;
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
  /** RFC 7591 §2 の jwks_uri。登録したときだけ持つ（acceptJwksUri: false の OP では持たない）。 */
  jwksUri?: string;
  /**
   * OIDC Dynamic Client Registration 1.0 §2 の request_object_signing_alg。
   * requestObjectSigningAlgValuesSupported を渡した OP で登録したときだけ持つ。
   */
  requestObjectSigningAlg?: string;
  /**
   * OIDC Dynamic Client Registration 1.0 §2 の token_endpoint_auth_signing_alg。
   * tokenEndpointAuthSigningAlgValuesSupported を渡した OP で登録したときだけ持つ。
   */
  tokenEndpointAuthSigningAlg?: string;
  /**
   * OIDC Dynamic Client Registration 1.0 §2 の request_uris。acceptRequestUris の OP で
   * 登録したときだけ持つ。
   */
  requestUris?: string[];
  /** OIDC Dynamic Client Registration 1.0 §2 の client_name。登録したときだけ持つ。 */
  clientName?: string;
  /** RFC 7591 §2 の client_uri。登録したときだけ持つ。 */
  clientUri?: string;
  /** RFC 7591 §2 の logo_uri。登録したときだけ持つ。 */
  logoUri?: string;
  /** RFC 7591 §2 の policy_uri。登録したときだけ持つ。 */
  policyUri?: string;
  /** RFC 7591 §2 の tos_uri。登録したときだけ持つ。 */
  tosUri?: string;
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
  'request_object_signing_alg',
  'token_endpoint_auth_signing_alg',
  'request_uris',
  'software_statement',
];

const CLIENT_NAME_MAX_LENGTH = 128;
const SOFTWARE_ID_MAX_LENGTH = 128;
const SOFTWARE_VERSION_MAX_LENGTH = 64;

/**
 * 登録メタデータを検証し、既定値を適用して返す。
 *
 * 検証は、`redirect_uris`、`token_endpoint_auth_method`、`grant_types`、`response_types`、`grant_types` と `response_types` の対応、`application_type` ごとの `redirect_uris` の制約、`id_token_signed_response_alg` の順に行う。
 * 続いて、値があるときだけ任意のメタデータ（`client_name`、URL のメタデータ、`contacts`、`scope`、`software_id`、`software_version`、`jwks`、`jwks_uri`、`default_max_age`、`userinfo_signed_response_alg`、`request_object_signing_alg`、`token_endpoint_auth_signing_alg`、`request_uris`、`software_statement`）を検証し、最後にカスタムメタデータを検証する。
 * `token_endpoint_auth_method` が `private_key_jwt` の登録は、`jwks` か `jwks_uri` を求める（OIDC Core 1.0 §9）。
 * `token_endpoint_auth_signing_alg` は `options.tokenEndpointAuthSigningAlgValuesSupported` を渡した OP でだけ、`request_uris` は `options.acceptRequestUris` の OP でだけ登録し、ほかの OP では無視する。
 *
 * `jwks_uri` は宛先を検査して登録するが、登録の時点では取得しない。
 * `options.acceptJwksUri` が `false` の OP（`jwks_uri` を取得しない OP）では、理解しないメタデータとして無視する。
 * `request_object_signing_alg` は、`options.requestObjectSigningAlgValuesSupported` を渡した OP（リクエストオブジェクトを扱う OP）でだけ検証して登録し、渡さない OP では無視する。
 * `jwks` も登録するときは、その alg で使える鍵が `jwks` にあることも確かめる。
 *
 * 既定値は、RFC 7591 §2 のもの（`token_endpoint_auth_method`、`grant_types`、`response_types`）と、OIDC Dynamic Client Registration 1.0 §2 のもの（`application_type`、`id_token_signed_response_alg`）である。
 * 認可サーバーが適用した既定値はレスポンスに含めなければならない（OIDC Dynamic Client Registration 1.0 §3.2 の MUST）ので、どれも登録メタデータ（`metadata`）に書き込む。
 *
 * 理解しないフィールドは黙って捨てる（RFC 7591 §2 の MUST）。
 * 実装は理解するフィールドだけを新しいオブジェクトに選び取る方式で、解析結果をスプレッド構文や `Object.assign` でコピーしない。
 * `__proto__` のようにプロトタイプに関わるキーは読まれないので、登録の内容に影響しない。
 *
 * `metadata` に `software_statement` があれば、検証済みの JWT（`applySoftwareStatement()` が置いた値）として扱い、そのままレスポンスで返す。
 * カスタムメタデータの検証関数が `undefined` 以外を返した項目だけを登録する。
 *
 * @spec RFC 7591 §2
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec OIDC Dynamic Client Registration 1.0 §3.2
 * @throws {ClientRegistrationError} `invalid_redirect_uri`: `redirect_uris` がないか、規則に反する URI を含むとき。
 * @spec OIDC Core 1.0 §9
 * @throws {ClientRegistrationError} `invalid_client_metadata`: ほかのメタデータの値が正しくないとき、`grant_types` と `response_types` が対応しないとき、`jwks` と `jwks_uri` を両方含むとき、`jwks` に `request_object_signing_alg` か `token_endpoint_auth_signing_alg` で使える鍵がないとき、または `private_key_jwt` の登録が `jwks` も `jwks_uri` も持たないとき。
 * @throws {ClientRegistrationError} `invalid_software_statement`: `software_statement` が文字列でないとき。
 * @throws {TypeError} `customMetadata` に標準のメタデータと同じ名前があるとき（設定の誤り）。
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
  // `application_type` を省略したときも、既定値の `web` として検証する（OIDC Dynamic Client Registration 1.0 §2）。
  // 認可サーバーは、登録するすべての `redirect_uris` がその種別の制約（`web` でグラントタイプ `implicit` を使うなら `https` で `localhost` 以外、`native` ならカスタムスキームかループバックの `http`）に従うことを確かめなければならない（MUST）からである。
  const applicationType = validateApplicationType(
    metadata['application_type'] === undefined ? 'web' : metadata['application_type'],
  );
  validateRedirectUrisForApplicationType(redirectUris, applicationType, grantTypes);
  // `id_token_signed_response_alg` を省略したときは `RS256` として扱い（OIDC Dynamic Client Registration 1.0 §2）、既定値も OP が署名できるアルゴリズムの一覧と照らし合わせる。
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
    const clientName = validateDisplayString(metadata['client_name'], 'client_name', CLIENT_NAME_MAX_LENGTH);
    validated.clientName = clientName;
    registered['client_name'] = clientName;
  }
  // 画面に表示する URL（OIDC Dynamic Client Registration 1.0 §2 の SHOULD）は、`ValidatedClientRegistration` の名前でも持つ。
  const displayUris = [
    ['client_uri', 'clientUri'],
    ['logo_uri', 'logoUri'],
    ['tos_uri', 'tosUri'],
    ['policy_uri', 'policyUri'],
  ] as const;
  for (const [name, field] of displayUris) {
    if (metadata[name] !== undefined) {
      const uri = validateHttpUrl(metadata[name], name);
      validated[field] = uri;
      registered[name] = uri;
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
    // `jwks` と `jwks_uri` を両方含む登録は、`acceptJwksUri` の値によらず拒否する（RFC 7591 §2 は同時に使うことを禁じている）。
    throw new ClientRegistrationError('invalid_client_metadata', 'jwks and jwks_uri must not both be present');
  }
  if (metadata['jwks'] !== undefined) {
    const jwks = validateJwks(metadata['jwks']);
    validated.jwks = jwks;
    registered['jwks'] = { keys: jwks.keys.map((key) => ({ ...key })) };
  }
  // `acceptJwksUri` が `false` の OP では、`jwks_uri` を理解しないメタデータとして無視する。
  // 登録の時点では取得せず、宛先を検査するだけにする。
  if (metadata['jwks_uri'] !== undefined && options?.acceptJwksUri !== false) {
    const jwksUri = validateJwksUri(metadata['jwks_uri'], options?.allowInsecureJwksUri === true);
    validated.jwksUri = jwksUri;
    registered['jwks_uri'] = jwksUri;
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
  // `requestObjectSigningAlgValuesSupported` を渡さない OP（リクエストオブジェクトを扱わない OP）では、
  // `request_object_signing_alg` を理解しないメタデータとして無視する。
  const requestObjectSigningAlgs = options?.requestObjectSigningAlgValuesSupported;
  if (metadata['request_object_signing_alg'] !== undefined && requestObjectSigningAlgs !== undefined) {
    const alg = validateRequestObjectSigningAlg(metadata['request_object_signing_alg'], requestObjectSigningAlgs);
    // 登録した鍵で検証できない登録に、リクエストオブジェクトを送る前に気づかせる。
    // `jwks_uri` の鍵は登録の時点では取得しないので、照らし合わせない。
    if (alg !== 'none' && validated.jwks !== undefined && !validated.jwks.keys.some((key) => resolveJwkSigningAlg(key) === alg)) {
      throw new ClientRegistrationError(
        'invalid_client_metadata',
        'jwks must contain a key that can be used with the request_object_signing_alg',
      );
    }
    validated.requestObjectSigningAlg = alg;
    registered['request_object_signing_alg'] = alg;
  }
  // `private_key_jwt` のクライアントは、アサーションを検証する公開鍵（`jwks` か `jwks_uri`）を登録しなければならない（OIDC Core 1.0 §9）。
  // 鍵の無い登録は、どのリクエストでも認証できないクライアントになるので、登録の時点で拒否する。
  if (tokenEndpointAuthMethod === 'private_key_jwt' && validated.jwks === undefined && validated.jwksUri === undefined) {
    throw new ClientRegistrationError(
      'invalid_client_metadata',
      'private_key_jwt requires jwks or jwks_uri',
    );
  }
  // `tokenEndpointAuthSigningAlgValuesSupported` を渡さない OP では、`token_endpoint_auth_signing_alg` を理解しないメタデータとして無視する。
  const tokenEndpointAuthSigningAlgs = options?.tokenEndpointAuthSigningAlgValuesSupported;
  if (metadata['token_endpoint_auth_signing_alg'] !== undefined && tokenEndpointAuthSigningAlgs !== undefined) {
    // `none` は署名の無いアサーションなので、一覧にあっても受け付けない（OIDC Dynamic Client Registration 1.0 §2）。
    const alg = validateSigningAlg(
      metadata['token_endpoint_auth_signing_alg'],
      'token_endpoint_auth_signing_alg',
      tokenEndpointAuthSigningAlgs.filter((supported) => supported !== 'none'),
    );
    // 登録した鍵で検証できない登録に、アサーションを送る前に気づかせる。
    // `jwks_uri` の鍵は登録の時点では取得しないので、照らし合わせない。
    if (validated.jwks !== undefined && !validated.jwks.keys.some((key) => resolveJwkSigningAlg(key) === alg)) {
      throw new ClientRegistrationError(
        'invalid_client_metadata',
        'jwks must contain a key that can be used with the token_endpoint_auth_signing_alg',
      );
    }
    validated.tokenEndpointAuthSigningAlg = alg;
    registered['token_endpoint_auth_signing_alg'] = alg;
  }
  // `acceptRequestUris` の OP（`request_uri` を扱う OP）でだけ、`request_uris` を登録する。
  if (metadata['request_uris'] !== undefined && options?.acceptRequestUris === true) {
    const requestUris = validateRequestUris(metadata['request_uris'], options.allowInsecureRequestUris === true);
    validated.requestUris = requestUris;
    registered['request_uris'] = [...requestUris];
  }
  if (metadata['software_statement'] !== undefined) {
    // 登録に使った `software_statement` は、そのままレスポンスで返す（RFC 7591 §3.2.1）。
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
 * 登録リクエストのボディを検証し、既定値を適用して返す。
 *
 * {@link parseClientRegistrationBody} と {@link validateClientMetadata} を続けて呼ぶだけの関数である。
 * `software_statement` は、文字列でなければ `parseClientRegistrationBody` が `invalid_software_statement` を投げるが、文字列なら中身を検証せずに無視する（RFC 7591 §3.1.1 は、対応しない認可サーバーが無視することを認めている）。
 * ソフトウェアステートメントを受け付ける OP は、この関数を使わずに、2 つの関数のあいだで設定の検証関数と `applySoftwareStatement()`（`software-statement.ts`）を呼ぶ。
 *
 * @spec RFC 7591 §3.1.1
 * @throws {ClientRegistrationError} `invalid_redirect_uri`、`invalid_client_metadata`、`invalid_software_statement`: 中で呼ぶ 2 つの関数のどちらかが投げたとき。
 * @throws {TypeError} `customMetadata` に標準のメタデータと同じ名前があるとき。
 */
export function validateClientRegistrationRequest(
  rawBody: string,
  options?: ValidateClientRegistrationOptions,
): ValidatedClientRegistration {
  const { metadata } = parseClientRegistrationBody(rawBody, options);
  return validateClientMetadata(metadata, options);
}

/**
 * `redirect_uris` を検証し、同じ値の新しい配列を返す。
 *
 * `redirect_uris` は必須（REQUIRED）である（OIDC Dynamic Client Registration 1.0 §2）。
 * 空でない文字列の配列でなければ、`invalid_redirect_uri` を投げる。
 *
 * URI の規則そのもの（スキームがあること、フラグメントがないこと、危険なスキームでないこと、ループバック以外の `http` でないこと）は core の `validateRegisteredRedirectUris()` に任せ、静的なクライアントと同じ登録の基準を適用する。
 * ネイティブアプリ向けのカスタムスキームは通る。
 * core の例外は違反した URI をメッセージに含む `server_error` なので、コードを `invalid_redirect_uri`（RFC 7591 §3.2.2）に、文言を URI を含まない固定の ASCII の文に差し替えて投げ直す。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @spec RFC 7591 §3.2.2
 * @throws {ClientRegistrationError} `invalid_redirect_uri`: 空でない文字列の配列でないとき、または core の規則に反する URI を含むとき。
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

/**
 * `token_endpoint_auth_method` を検証して返す。
 *
 * 省略できる（OPTIONAL）メタデータで、省略したときは既定値の `client_secret_basic` を返す（RFC 7591 §2）。
 * 文字列でないか、`supported` にない値なら、`invalid_client_metadata` を投げる。
 *
 * @spec RFC 7591 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 登録できない認証方式のとき。
 */
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
 * `grant_types` を検証し、重複を除いた配列を返す。
 *
 * 省略できる（OPTIONAL）メタデータで、省略したときは既定値の `["authorization_code"]` を返す（RFC 7591 §2）。
 * 配列でないか、`supported` にない値を含むときは、`invalid_client_metadata` を投げる。
 * 重複は 1 つにまとめ、最初に現れた順を保つ。
 *
 * @spec RFC 7591 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 配列でないとき、または登録できないグラントタイプを含むとき。
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
 * `response_types` を検証し、正規化した配列を返す。
 *
 * 省略できる（OPTIONAL）メタデータで、省略したときは既定値の `["code"]` を返す（RFC 7591 §2）。
 * 値は空白で区切った語の並びで、語の順序は意味を持たない（OAuth 2.0 Multiple Response Type Encoding Practices §1.2）。
 * そのため、core の `normalizeResponseType()` で語を並べ直してから `supported` と照らし合わせ、重複を 1 つにまとめる。
 * 空でない配列でないとき、または `supported` にない値を含むときは、`invalid_client_metadata` を投げる。
 *
 * @spec RFC 7591 §2
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §1.2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 空でない配列でないとき、または登録できないレスポンスタイプを含むとき。
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
 * `grant_types` と `response_types` の対応を確かめる。
 *
 * `code` を含むレスポンスタイプはグラントタイプ `authorization_code` を、`token` か `id_token` を含むレスポンスタイプはグラントタイプ `implicit` を必要とする。
 * 逆に、これらのグラントタイプを登録したときは、対応するレスポンスタイプが必要である。
 * 対応しない登録は、使えない組み合わせを登録させないために `invalid_client_metadata` で拒否する（RFC 7591 §2.1 の SHOULD）。
 *
 * @spec RFC 7591 §2.1
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 対応しないとき。
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
