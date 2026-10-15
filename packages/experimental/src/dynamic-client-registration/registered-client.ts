/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — 登録レコードと 201 応答の
 * 組み立て。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * ここはストアに触れない純関数で、発行値（client_id / client_secret）の生成と
 * §3.2.1 応答の形だけを持つ。保存と上限検査は生成コードの責務。
 */

import { generateRandomString } from '@maronn-openid-connect/core';
import type { ValidatedClientRegistration } from './registration-request.js';

/**
 * 発行値を含む登録レコード。生成コードの RegisteredClient 型
 * （core の ClientInfo & TokenClientInfo を合成した型）へそのまま適合する。
 * clientName と clientIdIssuedAt は core が解釈しない付加情報で、応答の
 * 組み立てだけに使われる。
 */
export interface DynamicallyRegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientType: 'confidential' | 'public';
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'none';
  clientName?: string;
  /**
   * RFC 7591 §2 `scope`: 登録時に許可した scope 一覧。core の ClientInfo.scope
   * としてそのまま解釈され、一覧外の scope 要求は invalid_scope で拒否される。
   * 省略時はクライアント単位の制限を掛けない。
   */
  scope?: string[];
  clientIdIssuedAt: number;
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
}

/**
 * client_id の固定プレフィックス。静的クライアントの client_id は人間が
 * 命名する（例: example-client）ため、このプレフィックスで名前空間が分かれ、
 * 既存クライアントとの衝突・上書きが構造的に起きない。client_id は秘密情報
 * ではないので、動的登録由来であることを明かしても失うものはない。
 */
const CLIENT_ID_PREFIX = 'dcr-';

/**
 * 検証済みメタデータから登録レコードを組み立てる。
 *
 * token_endpoint_auth_method が none のクライアントはシークレットを持てない
 * （RFC 6749 §2.1 の public client）ため、clientType: 'public' とし
 * client_secret を発行しない。それ以外は confidential として 256 ビットの
 * シークレットを発行する。
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

  const isPublic = metadata.tokenEndpointAuthMethod === 'none';
  return {
    clientId: generateClientId(),
    ...(isPublic ? {} : { clientSecret: generateClientSecret() }),
    clientType: isPublic ? 'public' : 'confidential',
    redirectUris: [...metadata.redirectUris],
    grantTypes: [...metadata.grantTypes],
    responseTypes: [...metadata.responseTypes],
    tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
    ...(metadata.clientName === undefined ? {} : { clientName: metadata.clientName }),
    ...(metadata.scope === undefined ? {} : { scope: [...metadata.scope] }),
    clientIdIssuedAt: Math.floor(now() / 1000),
  };
}

/**
 * 201 応答ボディ（RFC 7591 §3.2.1。スネークケースの JSON オブジェクト）を
 * 組み立てる。§3.2.1 は「登録済みの全メタデータを返す MUST」なので、既定値
 * 適用後の値もすべて載せる。client_secret_expires_at は client_secret を
 * 発行した場合のみの REQUIRED で、0 は「無期限」を意味する。
 *
 * registration_access_token / registration_client_uri は返さない（RFC 7592 は
 * 非目標。OIDC Dynamic Client Registration 1.0 §3.2 の「両方返すか両方返さ
 * ないか」の MUST に従い、両方返さない側を選ぶ）。
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
    redirect_uris: [...client.redirectUris],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    grant_types: [...client.grantTypes],
    response_types: [...client.responseTypes],
    ...(client.clientName === undefined ? {} : { client_name: client.clientName }),
    // scope は RFC 6749 §3.3 の表現（スペース区切り文字列）へ戻して返す。
    ...(client.scope === undefined ? {} : { scope: client.scope.join(' ') }),
  };
}
