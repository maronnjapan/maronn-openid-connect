/**
 * クライアント認証
 * OAuth 2.1 Section 2.3 / OIDC Core 1.0 Section 9
 *
 * Token Endpoint で受け付けるクライアント認証方式:
 * - client_secret_basic: Authorization: Basic base64(clientId:clientSecret)
 * - client_secret_post:  リクエストボディの client_id + client_secret
 *
 * OAuth 2.1 Section 2.3: 1リクエストにつき1つの認証方式のみ使用しなければならない。
 */

import { timingSafeEqual } from './crypto-utils';
import {
  resolveAuthenticatedTokenClient,
  TokenError,
  TokenErrorCode,
} from './token-request';
import type { TokenClientInfo, TokenClientResolver } from './token-request';

/**
 * クライアント認証コンテキスト
 */
export interface ClientAuthContext {
  /** リクエストボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string | undefined>;
  /** Authorization ヘッダーの値（無ければ空文字） */
  authorizationHeader: string;
  /** クライアント情報を解決するリゾルバー */
  clientResolver: TokenClientResolver;
}

/**
 * RFC 6749 Section 2.3.1: credentials are application/x-www-form-urlencoded encoded.
 * '+' represents space; '%XX' sequences are percent-decoded.
 */
function formUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, '%20'));
}

/**
 * Authorization: Basic ヘッダーから clientId/clientSecret を抽出する。
 * Basic 形式でない、または base64 / フォーマットが不正な場合は null。
 */
/**
 * RFC 7235 Section 2.1: HTTP authentication scheme は case-insensitive。
 * スキーム名のみを ASCII 小文字化して指定スキームと比較する。
 * 認証情報本体（base64 や bearer token 値）は変換しない。
 */
function matchAuthScheme(
  authHeader: string,
  scheme: string,
): string | null {
  const spaceIndex = authHeader.indexOf(' ');
  if (spaceIndex === -1) {
    return null;
  }
  const headerScheme = authHeader.slice(0, spaceIndex).toLowerCase();
  if (headerScheme !== scheme.toLowerCase()) {
    return null;
  }
  return authHeader.slice(spaceIndex + 1);
}

function hasAuthScheme(authHeader: string, scheme: string): boolean {
  return matchAuthScheme(authHeader, scheme) !== null;
}

function parseBasicAuth(
  authHeader: string,
): { clientId: string; clientSecret: string } | null {
  const base64Credentials = matchAuthScheme(authHeader, 'Basic');
  if (base64Credentials === null) {
    return null;
  }
  let decoded: string;
  try {
    const binary = atob(base64Credentials);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  // RFC 6749 Section 2.3.1: decode form-urlencoded credentials after splitting
  try {
    return {
      clientId: formUrlDecode(decoded.slice(0, separatorIndex)),
      clientSecret: formUrlDecode(decoded.slice(separatorIndex + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * リクエストが提示したクライアント資格情報。
 *
 * `method` は「実際に使われた認証方式」であり、クライアントに登録された
 * `token_endpoint_auth_method` ではない。両者の一致は
 * {@link validateClientAuthMethod} が検証する。
 */
export interface PresentedClientCredentials {
  clientId: string;
  /** 提示された client_secret。public client（method='none'）では undefined */
  clientSecret?: string;
  /** 実際に使われた認証方式 */
  method: 'client_secret_basic' | 'client_secret_post' | 'none';
}

/**
 * ステップ 1: リクエストからクライアント資格情報を抽出する
 * OAuth 2.1 Section 2.3 / OIDC Core 1.0 Section 9
 *
 * - `Authorization: Basic` → client_secret_basic
 * - ボディの client_id + client_secret → client_secret_post
 * - ボディの client_id のみ → none（public client の識別）
 *
 * OAuth 2.1 §2.3: 1リクエストにつき1つの認証方式のみ使用しなければならない。
 * RFC 6749 §4.1.3: 未認証クライアントも client_id を送らなければならない。
 *
 * @throws {TokenError} invalid_request（複数方式）/ invalid_client（形式不正・client_id 欠落）
 */
export function extractClientCredentials(
  context: Pick<ClientAuthContext, 'params' | 'authorizationHeader'>,
): PresentedClientCredentials {
  const { params, authorizationHeader } = context;

  const hasBasicHeader = hasAuthScheme(authorizationHeader, 'Basic');
  const hasPostCredential =
    params.client_id !== undefined || params.client_secret !== undefined;

  // OAuth 2.1 Section 2.3: 認証方式を同時に複数使ってはいけない
  if (hasBasicHeader && hasPostCredential) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Multiple client authentication methods provided. Use either Authorization header or request body, not both.',
    );
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (hasBasicHeader) {
    const basic = parseBasicAuth(authorizationHeader);
    if (!basic) {
      throw new TokenError(
        TokenErrorCode.InvalidClient,
        'Invalid Authorization header format',
      );
    }
    clientId = basic.clientId;
    clientSecret = basic.clientSecret;
  } else if (hasPostCredential) {
    clientId = params.client_id;
    clientSecret = params.client_secret;
  }

  // client_id は public / confidential を問わず必須。
  // RFC 6749 §4.1.3: 未認証クライアントは client_id を送らなければならない。
  if (!clientId) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication required',
    );
  }

  const method: PresentedClientCredentials['method'] = hasBasicHeader
    ? 'client_secret_basic'
    : clientSecret !== undefined
      ? 'client_secret_post'
      : 'none';

  return { clientId, clientSecret, method };
}

/**
 * ステップ 3: 使用された認証方式が登録方式と一致することを検証する
 * OIDC Core 1.0 Section 9 / RFC 7591 Section 2
 *
 * 登録方式の既定は client_secret_basic。
 * - 登録が `none`（public client）: 資格情報を一切提示していないことを要求する。
 *   提示していれば confidential への昇格混同を防ぐため拒否する。
 * - 登録が confidential 方式: client_secret 必須。実際に使われた方式が登録方式と
 *   異なる場合は認証方式ダウングレードを防ぐため拒否する。
 *
 * @throws {TokenError} invalid_client
 */
export function validateClientAuthMethod(
  client: TokenClientInfo,
  presented: PresentedClientCredentials,
): void {
  // OIDC Core 1.0 §9 / RFC 7591 §2: token_endpoint_auth_method の既定は client_secret_basic。
  const registeredMethod = client.tokenEndpointAuthMethod ?? 'client_secret_basic';

  // RFC 6749 §2.1 / §3.2.1 / OAuth 2.1 §2.4: public client（auth_method = none）は
  // client_id のみで識別し、クライアント認証を行わない。
  // ただし credentials を提示した場合は登録方式（none）と一致しないため拒否し、
  // confidential への昇格／ダウングレードの混同を防ぐ。
  if (registeredMethod === 'none') {
    if (presented.method !== 'none') {
      throw new TokenError(
        TokenErrorCode.InvalidClient,
        'Client authentication method does not match the registered token_endpoint_auth_method',
      );
    }
    return;
  }

  // confidential client は client_secret 必須。
  if (!presented.clientSecret) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication required',
    );
  }

  // 実際に使われた認証方式が登録方式と一致しなければ認証失敗とし、認証方式ダウングレードを防ぐ。
  if (presented.method !== registeredMethod) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication method does not match the registered token_endpoint_auth_method',
    );
  }
}

/**
 * ステップ 4: client_secret を定数時間比較で検証する
 * OAuth 2.1 Section 7.4.1 / RFC 6749 Section 10.10
 *
 * public client（登録方式 = none）は検証対象が無いためスキップする。
 *
 * @throws {TokenError} invalid_client
 */
export async function verifyClientSecret(
  client: TokenClientInfo,
  clientSecret: string | undefined,
): Promise<void> {
  const registeredMethod = client.tokenEndpointAuthMethod ?? 'client_secret_basic';
  if (registeredMethod === 'none') return;

  // OAuth 2.1 §7.4.1 / RFC 6749 §10.10: constant-time comparison to thwart timing attacks
  const secretMatches = await timingSafeEqual(
    client.clientSecret ?? '',
    clientSecret ?? '',
  );
  if (!secretMatches) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication failed',
    );
  }
}

/**
 * クライアント認証を行う
 *
 * 各ステップ関数を仕様順に合成した後方互換 API。CLI が生成する Provider は
 * この合成関数ではなく個々のステップ関数を順に呼び出すため、利用者は認証方式を
 * 差し替えたり検証を削除したりできる。
 *
 * 1. 資格情報の抽出（{@link extractClientCredentials}）
 * 2. クライアントの解決（{@link resolveAuthenticatedTokenClient}）
 * 3. 認証方式の一致検証（{@link validateClientAuthMethod}）
 * 4. client_secret の検証（{@link verifyClientSecret}）
 *
 * 認証成功時: 認証済みクライアントID（string）を返す
 * 認証失敗時: TokenError をスロー
 *
 * @param context クライアント認証コンテキスト
 * @returns 認証されたクライアントID
 * @throws {TokenError} 認証失敗時
 */
export async function authenticateClient(
  context: ClientAuthContext,
): Promise<string> {
  const { params, authorizationHeader, clientResolver } = context;

  const presented = extractClientCredentials({ params, authorizationHeader });
  const client = await resolveAuthenticatedTokenClient(presented.clientId, clientResolver);

  validateClientAuthMethod(client, presented);
  await verifyClientSecret(client, presented.clientSecret);

  return presented.clientId;
}
