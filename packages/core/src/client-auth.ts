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
import type { ClientAuthMethod, TokenClientInfo } from './token-request.js';

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
 * `+` を空白に戻し、パーセント符号化を復号して返す。
 *
 * `Basic` 認証で送るクライアント ID とシークレットは、`application/x-www-form-urlencoded` の形式で符号化されている（RFC 6749 §2.3.1）。
 * この形式では、`+` が空白を表し、`%XX` の並びがパーセント符号化された文字を表す。
 * 不正な `%` の並び（`%ZZ` など）があると、`decodeURIComponent()` が投げる `URIError` をそのまま投げる。
 *
 * @spec RFC 6749 §2.3.1
 */
function formUrlDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, '%20'));
}

/**
 * スキームが一致すれば、ヘッダー値の認証情報部分を返す。
 *
 * `Authorization` ヘッダーの値を最初の半角空白で分け、前半（スキーム名）と `scheme` をどちらも小文字にしてから比べる。
 * HTTP の認証スキームは大文字と小文字を区別しないためである。
 * 後半の認証情報（base64 の値やトークンの値）は変換せずに返す。
 * 空白を含まない値と、スキームが一致しない値には `null` を返す。
 *
 * @spec RFC 7235 §2.1
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

/**
 * 認証スキームが `scheme` と一致すれば true を返す。
 *
 * 認証スキームは `Authorization` ヘッダーの値の最初の半角空白より前の部分で、大文字と小文字を区別せずに比べる。
 * 空白を含まない値（`Basic` だけの値や空文字列）には false を返す。
 * スキームより後ろの認証情報は確かめないので、`Basic ` のように認証情報が空でも true を返す。
 *
 * @spec RFC 7235 §2.1
 */
function hasAuthScheme(authHeader: string, scheme: string): boolean {
  return matchAuthScheme(authHeader, scheme) !== null;
}

/**
 * `Basic` 認証のクライアント ID とシークレットを返す。
 *
 * `Authorization` ヘッダーの値のスキームが `Basic` なら、残りを base64 として復号し、UTF-8 の文字列として読む。
 * その文字列を最初の `:` で分け、前をクライアント ID、後ろをシークレットとして、それぞれを `application/x-www-form-urlencoded` の形式として復号する（RFC 6749 §2.3.1）。
 * スキームが `Basic` でない値、base64 として復号できない値、`:` を含まない値、不正な `%` の並びを含む値には `null` を返す。
 *
 * @spec RFC 6749 §2.3.1
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

  // `:` で分けてから、クライアント ID とシークレットをそれぞれ復号する（RFC 6749 §2.3.1）。
  // 先に復号すると、符号化された `:`（`%3A`）と区切りの `:` を区別できなくなる。
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
 * `method` は「実際に使われた認証方式」であり、クライアントに登録された方式
 * （`tokenEndpointAuthMethods`）ではない。使われた方式が登録された方式のどれかであることは
 * {@link validateClientAuthMethod} が検証する。
 */
export interface PresentedClientCredentials {
  clientId: string;
  /** 提示された client_secret。public client（method='none'）では undefined */
  clientSecret?: string;
  /** 実際に使われた認証方式 */
  method: ClientAuthMethod;
}

/**
 * リクエストから認証情報と認証方式を取り出して返す。
 *
 * 返す認証方式は実際に使われた方式で、次のように決める。
 * - `Authorization: Basic` ヘッダーがあれば `client_secret_basic`
 * - ボディに `client_id` と `client_secret` があれば `client_secret_post`
 * - ボディに `client_id` だけがあれば `none`（パブリッククライアントが自分を示す場合）
 *
 * 1 つのリクエストで使える認証方式は 1 つだけなので、`Basic` ヘッダーとボディの `client_secret` を両方送ったリクエストは拒否する（OAuth 2.1 §2.3）。
 * ボディの `client_id` はクライアントを示す識別子で認証方式ではないので、`Basic` ヘッダーと一緒に送られても受け付ける。
 * その場合は、`Basic` ヘッダーのクライアント ID と一致することを確かめる。
 *
 * 空文字列の `client_secret` は、送られなかったものとして扱う（RFC 6749 §3.2）。
 * クライアント ID は、認証しないクライアントも送らなければならない（RFC 6749 §4.1.3）。
 *
 * @spec OAuth 2.1 §2.3
 * @spec OIDC Core 1.0 §9
 * @throws {TokenError} `invalid_request`: `Basic` ヘッダーとボディの `client_secret` を両方送ったとき、またはボディの `client_id` が `Basic` ヘッダーのクライアント ID と違うとき
 * @throws {TokenError} `invalid_client`: `Basic` ヘッダーの値を読み取れないとき、またはクライアント ID がないとき
 */
export function extractClientCredentials(
  context: ClientAuthContext,
): PresentedClientCredentials {
  const { params, authorizationHeader } = context;

  // 空文字列の `client_secret` を、送られなかったもの（`undefined`）に置き換える。
  // 値のないパラメータは、リクエストから省かれたものとして扱わなければならない（RFC 6749 §3.2 の MUST）。
  // ここで一度置き換えるので、複数方式の判定、認証方式の判定、後の検証で空文字列の扱いが食い違わない。
  const postSecret =
    params.client_secret === '' ? undefined : params.client_secret;

  const hasBasicHeader = hasAuthScheme(authorizationHeader, 'Basic');
  const hasPostCredential =
    params.client_id !== undefined || postSecret !== undefined;

  // `Basic` ヘッダーとボディの `client_secret` を両方送っていれば `invalid_request` を投げる（RFC 6749 §2.3、OAuth 2.1 §2.3）。
  // 1 つのリクエストで複数の認証方式を使ってはならない。
  // ボディの `client_id` だけはクライアントを示す識別子で、認証方式ではない（RFC 6749 §3.2.1）。
  // そのため判定にはボディの `client_secret`（`client_secret_post` の認証情報）の有無だけを使い、多くのクライアントライブラリが送る「`Basic` ヘッダーとボディの `client_id`」の組み合わせは拒否しない。
  // 空の `client_secret` は認証情報を含まないので、もう一つの認証方式には数えない。
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
    // ボディの `client_id` が `Basic` ヘッダーのクライアント ID と違えば `invalid_request` を投げる（RFC 6749 §3.2.1）。
    // `Basic` ヘッダーと一緒に送られた `client_id` は識別子として受け付けるが、食い違いはクライアントの設定の誤りや取り違えとして拒否する。
    validateClientIdConsistency(params.client_id, basic.clientId);
    clientId = basic.clientId;
    clientSecret = basic.clientSecret;
  } else if (hasPostCredential) {
    clientId = params.client_id;
    clientSecret = postSecret;
  }

  // クライアント ID がなければ `invalid_client` を投げる。
  // パブリッククライアントもコンフィデンシャルクライアントもクライアント ID は必須で、認証しないクライアントも `client_id` を送らなければならない（RFC 6749 §4.1.3）。
  const requiredClientId = requireClientId(clientId);

  const method = selectPresentedClientAuthMethod({
    hasBasicHeader,
    hasClientSecret: clientSecret !== undefined,
  });

  return { clientId: requiredClientId, clientSecret, method };
}

/**
 * 使われた認証方式を、クライアントの登録と照合する。
 *
 * 登録された方式（`tokenEndpointAuthMethods`）がなければ、既定の `client_secret_basic` だけが登録されているものとして扱う。
 *
 * 登録が `none`（パブリッククライアント）なら、使われた方式も `none` であること、つまり認証情報を何も提示していないことを求める。
 * 認証情報を提示していれば拒否し、パブリッククライアントをコンフィデンシャルクライアントと取り違えるのを防ぐ。
 *
 * 登録がコンフィデンシャルクライアントの方式なら、`client_secret` の提示を求めたうえで、使われた方式が登録された方式のどれかであることを確かめる。
 * 登録されていない方式を拒否するのは、認証方式のダウングレードを防ぐためである。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7591 §2
 * @throws {TokenError} `invalid_client`: 使われた方式が登録されていないとき、またはコンフィデンシャルクライアントが `client_secret` を提示していないとき
 * @throws {Error} 登録で `none` をほかの方式と並べているとき（{@link selectRegisteredClientAuthMethods}）
 */
export function validateClientAuthMethod(
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethods'>,
  presented: Pick<PresentedClientCredentials, 'method' | 'clientSecret'>,
): void {
  const registeredMethods = selectRegisteredClientAuthMethods(client);

  // パブリッククライアント（登録した方式が `none`）は、使われた方式が `none` であることだけを確かめて返る（RFC 6749 §2.1、§3.2.1、OAuth 2.1 §2.4）。
  // パブリッククライアントは `client_id` だけで自分を示し、クライアント認証をしない。
  // 認証情報を提示していれば、使われた方式が `none` と一致しないので拒否し、コンフィデンシャルクライアントとの取り違え（昇格やダウングレード）を防ぐ。
  if (registeredMethods.includes('none')) {
    validateClientAuthMethodAllowed(presented.method, registeredMethods);
    return;
  }

  // コンフィデンシャルクライアントが `client_secret` を提示していなければ `invalid_client` を投げる。
  requireClientSecret(presented.clientSecret);

  // 使われた認証方式が登録された方式のどれでもなければ `invalid_client` を投げ、認証方式のダウングレードを防ぐ。
  validateClientAuthMethodAllowed(presented.method, registeredMethods);
}

/**
 * `client_secret` を登録値と定数時間で照合する。
 *
 * パブリッククライアント（登録した方式が `none`）には照合するシークレットがないので、何も確かめずに返る。
 * `clientSecretHash` が登録されていれば、提示値のハッシュをその値と比べ、`clientSecret` は使わない（{@link verifyClientSecretHash}）。
 * 登録されていなければ、提示値を `clientSecret` と比べる（{@link verifyClientSecretValue}）。
 *
 * @spec OAuth 2.1 §7.4.1
 * @spec RFC 6749 §10.10
 * @throws {TokenError} `invalid_client`: 提示値が登録値と一致しないとき（`clientSecretHash` と照合する場合は、提示値がないときも）
 * @throws {Error} 登録で `none` をほかの方式と並べているとき（{@link selectRegisteredClientAuthMethods}）
 */
export async function verifyClientSecret(
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethods' | 'clientSecret' | 'clientSecretHash'>,
  clientSecret: string | undefined,
): Promise<void> {
  if (isPublicTokenClient(client)) return;

  if (client.clientSecretHash !== undefined) {
    await verifyClientSecretHash(clientSecret, client.clientSecretHash);
    return;
  }
  await verifyClientSecretValue(clientSecret, client.clientSecret);
}

/**
 * シークレットの SHA-256 ハッシュを base64url で返す。
 *
 * 返す値は、クライアントを登録するときに {@link TokenClientInfo.clientSecretHash} に保存する値である。
 * base64url の末尾にパディング（`=`）は付けない。
 */
export async function hashClientSecret(clientSecret: string): Promise<string> {
  return sha256(clientSecret);
}

/**
 * `Basic` ヘッダーと `client_secret` の併用を拒否する。
 *
 * 1 つのリクエストで使える認証方式は 1 つだけなので、`Basic` ヘッダーとボディの `client_secret` の両方があれば拒否する。
 * 空文字列の `client_secret` は、送られなかったものとして扱う（RFC 6749 §3.2）。
 *
 * @spec OAuth 2.1 §2.3
 * @throws {TokenError} `invalid_request`: `Basic` ヘッダーがあり、ボディに空でない `client_secret` もあるとき
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
 * ボディと `Basic` の `client_id` の一致を検証する。
 *
 * `Basic` ヘッダーと一緒にボディで送られた `client_id` は識別子として受け付けるが、`Basic` ヘッダーのクライアント ID と違えば拒否する。
 * ボディの `client_id` が省略されていれば、何も確かめない。
 *
 * @spec RFC 6749 §3.2.1
 * @throws {TokenError} `invalid_request`: ボディの `client_id` が `Basic` ヘッダーのクライアント ID と違うとき
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
 * クライアント ID があればそのまま返す。
 *
 * 認証しないパブリッククライアントも `client_id` を送らなければならないので、どの認証方式でも必須として確かめる。
 *
 * @spec RFC 6749 §4.1.3
 * @throws {TokenError} `invalid_client`: クライアント ID が `undefined` か空文字列のとき
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
 * リクエストが実際に使った認証方式を返す。
 *
 * 次の順に判定する。
 * - `Basic` ヘッダーがあれば `client_secret_basic`
 * - シークレットがあれば `client_secret_post`
 * - どちらもなければ `none`
 *
 * 登録された方式との照合はしない（{@link validateClientAuthMethod} が行う）。
 */
export function selectPresentedClientAuthMethod(presented: {
  hasBasicHeader: boolean;
  hasClientSecret: boolean;
}): PresentedClientCredentials['method'] {
  if (presented.hasBasicHeader) return 'client_secret_basic';
  return presented.hasClientSecret ? 'client_secret_post' : 'none';
}

/**
 * クライアントが使ってよい認証方式の一覧を返す。
 *
 * `tokenEndpointAuthMethods` が登録されていれば、その複製を返す。
 * 登録されていなければ、既定の `client_secret_basic` だけの一覧を返す。
 *
 * @spec OIDC Core 1.0 §9
 * @spec RFC 7591 §2
 * @throws {Error} 登録で `none` をほかの方式と並べているとき（パブリッククライアントかどうかが決まらないため）
 */
export function selectRegisteredClientAuthMethods(
  client: Pick<TokenClientInfo, 'tokenEndpointAuthMethods'>,
): ClientAuthMethod[] {
  const methods = client.tokenEndpointAuthMethods;
  if (methods === undefined) return ['client_secret_basic'];
  if (methods.includes('none') && methods.length > 1) {
    throw new Error('tokenEndpointAuthMethods must not list none together with another method');
  }
  return [...methods];
}

/**
 * パブリッククライアントなら true を返す。
 *
 * パブリッククライアントは登録した方式が `none` のクライアントで、クライアント認証をせず、`client_id` だけで自分を示す。
 * 方式が登録されていなければ、既定の `client_secret_basic` として扱うので false を返す。
 *
 * @spec OAuth 2.1 §2.4
 * @spec RFC 7591 §2
 * @throws {Error} 登録で `none` をほかの方式と並べているとき（{@link selectRegisteredClientAuthMethods}）
 */
export function isPublicTokenClient(client: Pick<TokenClientInfo, 'tokenEndpointAuthMethods'>): boolean {
  return selectRegisteredClientAuthMethods(client).includes('none');
}

/**
 * `client_secret` が提示されていればそのまま返す。
 *
 * コンフィデンシャルクライアントが `client_secret` を提示したことを確かめるために使う。
 *
 * @throws {TokenError} `invalid_client`: `client_secret` が `undefined` か空文字列のとき
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
 * 使われた認証方式が登録の一覧にあるかを検証する。
 *
 * 一覧にない方式を拒否するのは、認証方式のダウングレードや、パブリッククライアントとコンフィデンシャルクライアントの取り違えを防ぐためである。
 *
 * @spec OIDC Core 1.0 §9
 * @throws {TokenError} `invalid_client`: 使われた方式が `registeredMethods` にないとき
 */
export function validateClientAuthMethodAllowed(
  presentedMethod: ClientAuthMethod,
  registeredMethods: readonly ClientAuthMethod[],
): void {
  if (!registeredMethods.includes(presentedMethod)) {
    throw new TokenError(
      TokenErrorCode.InvalidClient,
      'Client authentication method is not registered for the client',
    );
  }
}

/**
 * 提示されたシークレットを登録値と定数時間で比べる。
 *
 * どちらかが `undefined` なら空文字列として比べるので、両方とも `undefined` なら一致したものとして扱う。
 * 提示の有無はこの関数では確かめない（コンフィデンシャルクライアントでは {@link validateClientAuthMethod} が確かめる）。
 *
 * @spec OAuth 2.1 §7.4.1
 * @spec RFC 6749 §10.10
 * @throws {TokenError} `invalid_client`: 提示値と登録値が一致しないとき
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
 * シークレットのハッシュを登録値と定数時間で比べる。
 *
 * 提示されたシークレットを {@link hashClientSecret} でハッシュにしてから、登録されたハッシュと比べる。
 * シークレットが `undefined` か空文字列なら比べずに拒否するので、空文字列のハッシュが登録されていても、シークレットを提示しないリクエストは通らない。
 *
 * @spec OAuth 2.1 §7.4.1
 * @spec RFC 6749 §10.10
 * @throws {TokenError} `invalid_client`: シークレットがないとき、またはハッシュが一致しないとき
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
