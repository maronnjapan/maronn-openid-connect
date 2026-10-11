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

import { sha256, timingSafeEqual } from './crypto-utils.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import type { TokenClientInfo } from './token-request.js';

/**
 * クライアント認証コンテキスト
 */
export interface ClientAuthContext {
  /** リクエストボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string | undefined>;
  /** Authorization ヘッダーの値（無ければ空文字） */
  authorizationHeader: string;
}

/**
 * RFC 6749 Section 2.3.1: credentials are application/x-www-form-urlencoded encoded.
 * '+' represents space; '%XX' sequences are percent-decoded.
 */
function formUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, '%20'));
}

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

/**
 * Authorization: Basic ヘッダーから clientId/clientSecret を抽出する。
 * Basic 形式でない、または base64 / フォーマットが不正な場合は null。
 */
export function parseBasicClientCredentials(
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
  context: ClientAuthContext,
): PresentedClientCredentials {
  const { params, authorizationHeader } = context;

  // RFC 6749 §3.2: "Parameters sent without a value MUST be treated as if they
  // were omitted from the request." 空文字列の client_secret はここで「未提示」に
  // 正規化し、多重方式判定・method 判定・後段検証の意味論を一箇所で揃える。
  const postSecret =
    params.client_secret === '' ? undefined : params.client_secret;

  const hasBasicHeader = hasAuthScheme(authorizationHeader, 'Basic');
  const hasPostCredential =
    params.client_id !== undefined || postSecret !== undefined;

  // RFC 6749 §2.3 / OAuth 2.1 §2.3: 1リクエストで複数の「認証方式」を併用してはいけない。
  // ただし §3.2.1 の client_id 単独送信は自身を識別するための「識別子」であって認証方式ではない。
  // よって多重認証方式の判定はボディの client_secret（client_secret_post の資格情報）の有無のみで行い、
  // Basic ヘッダ + ボディ client_id（secret なし）という多くのクライアントライブラリの実装を拒否しない。
  // 空値の client_secret は資格情報を運ばないため「もう一つの認証方式」に数えない（RFC 6749 §2.3）。
  validateSingleClientAuthMethod(hasBasicHeader, postSecret);

  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (hasBasicHeader) {
    const basic = parseBasicClientCredentials(authorizationHeader);
    if (!basic) {
      throw new TokenError(
        TokenErrorCode.InvalidClient,
        'Invalid Authorization header format',
      );
    }
    // RFC 6749 §3.2.1: Basic と併送された client_id は識別子として許容するが、
    // Basic 側の client_id と食い違う場合は矛盾（クライアント設定ミス／混同）として拒否する。
    validateClientIdConsistency(params.client_id, basic.clientId);
    clientId = basic.clientId;
    clientSecret = basic.clientSecret;
  } else if (hasPostCredential) {
    clientId = params.client_id;
    clientSecret = postSecret;
  }

  // client_id は public / confidential を問わず必須。
  // RFC 6749 §4.1.3: 未認証クライアントは client_id を送らなければならない。
  const requiredClientId = requireClientId(clientId);

  const method = selectPresentedClientAuthMethod({
    hasBasicHeader,
    hasClientSecret: clientSecret !== undefined,
  });

  return { clientId: requiredClientId, clientSecret, method };
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
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethod'>,
  presented: Pick<PresentedClientCredentials, 'method' | 'clientSecret'>,
): void {
  const registeredMethod = selectRegisteredClientAuthMethod(client.tokenEndpointAuthMethod);

  // RFC 6749 §2.1 / §3.2.1 / OAuth 2.1 §2.4: public client（auth_method = none）は
  // client_id のみで識別し、クライアント認証を行わない。
  // ただし credentials を提示した場合は登録方式（none）と一致しないため拒否し、
  // confidential への昇格／ダウングレードの混同を防ぐ。
  if (registeredMethod === 'none') {
    validateClientAuthMethodMatch(presented.method, registeredMethod);
    return;
  }

  // confidential client は client_secret 必須。
  requireClientSecret(presented.clientSecret);

  // 実際に使われた認証方式が登録方式と一致しなければ認証失敗とし、認証方式ダウングレードを防ぐ。
  validateClientAuthMethodMatch(presented.method, registeredMethod);
}

/**
 * ステップ 4: client_secret を定数時間比較で検証する
 * OAuth 2.1 Section 7.4.1 / RFC 6749 Section 10.10
 *
 * public client（登録方式 = none）は検証対象が無いためスキップする。
 * clientSecretHash が登録されていれば、提示値のハッシュをそれと比べ、clientSecret は使わない。
 *
 * @throws {TokenError} invalid_client
 */
export async function verifyClientSecret(
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethod' | 'clientSecret' | 'clientSecretHash'>,
  clientSecret: string | undefined,
): Promise<void> {
  const registeredMethod = selectRegisteredClientAuthMethod(client.tokenEndpointAuthMethod);
  if (registeredMethod === 'none') return;

  if (client.clientSecretHash !== undefined) {
    await verifyClientSecretHash(clientSecret, client.clientSecretHash);
    return;
  }
  await verifyClientSecretValue(clientSecret, client.clientSecret);
}

/**
 * 登録用に client_secret のハッシュを作る。{@link TokenClientInfo.clientSecretHash} に保存する値で、
 * SHA-256 の base64url（パディング無し）。
 */
export async function hashClientSecret(clientSecret: string): Promise<string> {
  return sha256(clientSecret);
}

/**
 * OAuth 2.1 §2.3: Basic ヘッダーとボディの client_secret を併用していないことを検証する。
 * 空の client_secret は未提示として扱う（RFC 6749 §3.2）。
 */
export function validateSingleClientAuthMethod(
  hasBasicHeader: boolean,
  postSecret: string | undefined,
): void {
  if (hasBasicHeader && postSecret !== undefined && postSecret !== '') {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Multiple client authentication methods provided. Use either Authorization header or request body, not both.',
    );
  }
}

/**
 * RFC 6749 §3.2.1: Basic と併送されたボディの client_id が Basic 側と一致することを検証する。
 * ボディの client_id が省略されていれば検査しない。
 */
export function validateClientIdConsistency(
  bodyClientId: string | undefined,
  basicClientId: string,
): void {
  if (
    bodyClientId !== undefined &&
    bodyClientId !== basicClientId
  ) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'client_id in request body does not match the Authorization header',
    );
  }
}

/**
 * RFC 6749 §4.1.3: client_id があることを確かめる。public client も client_id を送る。
 */
export function requireClientId(clientId: string | undefined): string {
  if (!clientId) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication required',
    );
  }
  return clientId;
}

/**
 * リクエストが実際に使ったクライアント認証方式を選ぶ。
 * Basic ヘッダーがあれば client_secret_basic、ボディに secret があれば client_secret_post、
 * どちらも無ければ none とする。登録方式との照合は行わない。
 */
export function selectPresentedClientAuthMethod(presented: {
  hasBasicHeader: boolean;
  hasClientSecret: boolean;
}): PresentedClientCredentials['method'] {
  if (presented.hasBasicHeader) return 'client_secret_basic';
  return presented.hasClientSecret ? 'client_secret_post' : 'none';
}

/**
 * OIDC Core 1.0 §9 / RFC 7591 §2: 登録された token_endpoint_auth_method を返す。
 * 未登録なら既定の client_secret_basic を補う。
 */
export function selectRegisteredClientAuthMethod(
  tokenEndpointAuthMethod: TokenClientInfo['tokenEndpointAuthMethod'],
): NonNullable<TokenClientInfo['tokenEndpointAuthMethod']> {
  return tokenEndpointAuthMethod ?? 'client_secret_basic';
}

/**
 * confidential client が client_secret を提示していることを確かめる。
 */
export function requireClientSecret(clientSecret: string | undefined): string {
  if (!clientSecret) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication required',
    );
  }
  return clientSecret;
}

/**
 * 実際に使われた認証方式が登録方式と一致することを検証する。
 * 認証方式のダウングレードや public / confidential の混同を防ぐ（OIDC Core 1.0 §9）。
 */
export function validateClientAuthMethodMatch(
  presentedMethod: PresentedClientCredentials['method'],
  registeredMethod: NonNullable<TokenClientInfo['tokenEndpointAuthMethod']>,
): void {
  if (presentedMethod !== registeredMethod) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication method does not match the registered token_endpoint_auth_method',
    );
  }
}

/**
 * OAuth 2.1 §7.4.1 / RFC 6749 §10.10: 提示された client_secret を登録値と定数時間で比較する。
 * どちらかが未指定なら空文字として比較し、一致しなければ invalid_client。
 */
export async function verifyClientSecretValue(
  presentedSecret: string | undefined,
  registeredSecret: string | undefined,
): Promise<void> {
  const secretMatches = await timingSafeEqual(
    registeredSecret ?? '',
    presentedSecret ?? '',
  );
  if (!secretMatches) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication failed',
    );
  }
}

/**
 * OAuth 2.1 §7.4.1 / RFC 6749 §10.10: 提示された client_secret のハッシュを、登録された
 * ハッシュと定数時間で比較する。提示が無い、または一致しなければ invalid_client。
 * 空文字のハッシュが登録されていても、未提示の client_secret は通さない。
 */
export async function verifyClientSecretHash(
  presentedSecret: string | undefined,
  registeredHash: string,
): Promise<void> {
  const secretMatches =
    presentedSecret !== undefined &&
    presentedSecret !== '' &&
    (await timingSafeEqual(registeredHash, await hashClientSecret(presentedSecret)));
  if (!secretMatches) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication failed',
    );
  }
}
