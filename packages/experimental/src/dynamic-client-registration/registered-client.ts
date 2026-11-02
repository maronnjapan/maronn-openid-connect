/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — 登録レコードと 201 応答の
 * 組み立て。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * ここはストアに触れない純関数で、発行値（client_id / client_secret）の生成と
 * §3.2.1 応答の形だけを持つ。保存と上限検査は生成コードの責務。
 */

import { generateRandomString, type JwkSet } from '@maronn-openid-connect/core';
import type { ValidatedClientRegistration } from './registration-request.js';

/**
 * 発行値を含む登録レコード。
 *
 * core が解釈するフィールド（clientId / clientSecret / clientType / redirectUris /
 * grantTypes / responseTypes / tokenEndpointAuthMethods / scope / defaultMaxAge /
 * idTokenSignedResponseAlg / userinfoSignedResponseAlg）は生成コードの
 * RegisteredClient 型（core の ClientInfo & TokenClientInfo を合成した型）と同じ
 * 名前で持つ。jwks は生成コードが ClientKeyResolver の用途別の鍵へ写す。
 * metadata は登録した全メタデータのワイヤ形式で、201 応答の組み立てと、
 * client_name や logo_uri、カスタムメタデータを後から読むために保持する。
 *
 * tokenEndpointAuthMethods は、登録した token_endpoint_auth_method（RFC 7591 §2 は 1 つ）を
 * core の TokenClientInfo.tokenEndpointAuthMethods と同じ一覧の形で持つ。
 */
export interface DynamicallyRegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientType: 'confidential' | 'public';
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethods: [string];
  scope?: string[];
  defaultMaxAge?: number;
  /**
   * 登録した id_token_signed_response_alg。buildRegisteredClient は省略時の既定
   * RS256（OIDC Dynamic Client Registration 1.0 §2）を含めて必ず持たせる。
   * ほかで組み立てたレコードが欠くときも、core は RS256 として扱う。
   */
  idTokenSignedResponseAlg?: string;
  userinfoSignedResponseAlg?: string;
  jwks?: JwkSet;
  clientIdIssuedAt: number;
  metadata: Record<string, unknown>;
}

export interface BuildRegisteredClientOptions {
  /**
   * テスト用の注入点。省略時の既定は
   * generateClientId: () => `dcr-${generateRandomString(16)}`（128 ビット乱数）、
   * generateClientSecret: () => generateRandomString(32)（256 ビット乱数、43 文字）。
   */
  generateClientId?: () => string;
  generateClientSecret?: () => string;
  /** 現在時刻（ミリ秒）。省略時は Date.now。 */
  now?: () => number;
  /**
   * client_secret で認証する token_endpoint_auth_method。これらを登録した
   * クライアントにだけ client_secret を発行する。既定は client_secret_basic /
   * client_secret_post / client_secret_jwt。
   */
  clientSecretAuthMethods?: readonly string[];
}

/**
 * client_id の固定プレフィックス。静的クライアントの client_id は人間が
 * 命名する（例: example-client）ため、このプレフィックスで名前空間が分かれ、
 * 既存クライアントとの衝突・上書きが構造的に起きない。client_id は秘密情報
 * ではないので、動的登録由来であることを明かしても失うものはない。
 */
const CLIENT_ID_PREFIX = 'dcr-';

/** RFC 7591 §2 のうち client_secret を使う認証方式。 */
export const CLIENT_SECRET_AUTH_METHODS: readonly string[] = [
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
];

/**
 * 検証済みのメタデータから登録レコードを作って返す。
 *
 * `token_endpoint_auth_method` が `none` のクライアントはシークレットを持てない（RFC 6749 §2.1 のパブリッククライアント）ので、`clientType` を `'public'` にする。
 * それ以外のクライアントはコンフィデンシャルクライアントで、`client_secret` で認証する方式（`clientSecretAuthMethods`、既定は {@link CLIENT_SECRET_AUTH_METHODS}）を登録したクライアントにだけ、256 ビットのシークレットを発行する。
 * `private_key_jwt` のように鍵で認証する方式のクライアントは、コンフィデンシャルクライアントだがシークレットを持たない。
 *
 * 既定では、`client_id` は `dcr-` のあとに 16 バイト（128 ビット）の乱数の base64url を続けた値、シークレットは 32 バイトの乱数の base64url で、`clientIdIssuedAt` には現在時刻（秒）を入れる。
 * これらは `options` の `generateClientId`、`generateClientSecret`、`now` で差し替えられる。
 *
 * @spec RFC 6749 §2.1
 */
export function buildRegisteredClient(
  metadata: ValidatedClientRegistration,
  options?: BuildRegisteredClientOptions,
): DynamicallyRegisteredClient {
  const generateClientId =
    options?.generateClientId ?? (() => `${CLIENT_ID_PREFIX}${generateRandomString(16)}`);
  const generateClientSecret =
    options?.generateClientSecret ?? (() => generateRandomString(32));
  const now = options?.now ?? Date.now;
  const clientSecretAuthMethods = options?.clientSecretAuthMethods ?? CLIENT_SECRET_AUTH_METHODS;

  const isPublic = metadata.tokenEndpointAuthMethod === 'none';
  const issuesSecret = clientSecretAuthMethods.includes(metadata.tokenEndpointAuthMethod);
  return {
    clientId: generateClientId(),
    ...(issuesSecret ? { clientSecret: generateClientSecret() } : {}),
    clientType: isPublic ? 'public' : 'confidential',
    redirectUris: [...metadata.redirectUris],
    grantTypes: [...metadata.grantTypes],
    responseTypes: [...metadata.responseTypes],
    tokenEndpointAuthMethods: [metadata.tokenEndpointAuthMethod],
    ...(metadata.scope === undefined ? {} : { scope: [...metadata.scope] }),
    ...(metadata.defaultMaxAge === undefined ? {} : { defaultMaxAge: metadata.defaultMaxAge }),
    idTokenSignedResponseAlg: metadata.idTokenSignedResponseAlg,
    ...(metadata.userinfoSignedResponseAlg === undefined
      ? {}
      : { userinfoSignedResponseAlg: metadata.userinfoSignedResponseAlg }),
    ...(metadata.jwks === undefined ? {} : { jwks: { keys: metadata.jwks.keys.map((key) => ({ ...key })) } }),
    clientIdIssuedAt: Math.floor(now() / 1000),
    metadata: { ...metadata.metadata },
  };
}

/**
 * 登録レコードから 201 のレスポンスボディを作って返す。
 *
 * ボディはスネークケースの JSON オブジェクトで、`client_id` と `client_id_issued_at`、シークレットを発行したときは `client_secret` と `client_secret_expires_at` を入れ、そのあとに登録したメタデータ（既定値を適用したあとの値、`software_statement`、独自のメタデータを含む）をすべて入れる。
 * 登録したメタデータをすべて返すことは、RFC 7591 §3.2.1 の要求（MUST）である。
 * `client_secret_expires_at` は `client_secret` を発行したときだけ必須（REQUIRED）で、値の 0 は有効期限がないことを表す。
 *
 * `registration_access_token` と `registration_client_uri` は返さない。
 * RFC 7592 はこの機能の対象外であり、OpenID Connect Dynamic Client Registration 1.0 §3.2 の「両方を返すか、どちらも返さないか」という MUST に従って、どちらも返さない側を選んでいる。
 *
 * @spec RFC 7591 §3.2.1
 * @spec OpenID Connect Dynamic Client Registration 1.0 §3.2
 */
export function buildClientRegistrationResponse(
  client: DynamicallyRegisteredClient,
): Record<string, unknown> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret === undefined
      ? {}
      : { client_secret: client.clientSecret, client_secret_expires_at: 0 }),
    client_id_issued_at: client.clientIdIssuedAt,
    ...client.metadata,
  };
}
