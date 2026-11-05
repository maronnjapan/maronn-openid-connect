/**
 * Request Object passed by reference: the request_uri parameter.
 * OIDC Core 1.0 §6.2 / RFC 9101 §5.2 / §10.4
 *
 * The client puts its Request Object at a URL and sends that URL as
 * request_uri. The OP checks the URL (absolute, https, of a public host,
 * within a length), fetches it once with a bounded GET (no redirects, a
 * timeout, a body limit, Accept: application/jwt), and hands the JWT to the
 * same verification as a Request Object passed by value
 * (resolveRequestObjectParams()): the signature, the alg rules and
 * allowUnsigned are the same. A Request Object the OP cannot fetch is
 * invalid_request_uri; one that does not verify is invalid_request_object.
 * The fragment of the URL (a hash of the content, OIDC Dynamic Client
 * Registration 1.0 §2) is not sent.
 *
 * A request_uri of PAR (urn:ietf:params:oauth:request_uri:..., RFC 9126) is
 * not a URL: the PAR endpoint expands it before these functions run.
 */
import {
  AuthorizationError,
  AuthorizationErrorCode,
  type AuthorizationRequestParams,
} from './authorization-request.js';
import { validateClientJwksUri } from './client-jwks-uri.js';

/**
 * `request_uri` の検査か取得に失敗したことを表すエラー。
 *
 * メッセージには失敗の種類だけを書き、取得先の応答の中身は書かない。
 * {@link resolveRequestUriParams} は、これを理由を含まない固定の文言の `invalid_request_uri` に変える。
 */
export class RequestUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestUriError';
  }
}

/**
 * 値が {@link RequestUriError} なら true を返す。
 *
 * クラスではなく `name` で見分けるので、別に読み込まれた core の複製が投げたエラーも見分けられる。
 */
export function isRequestUriError(error: unknown): error is RequestUriError {
  return error instanceof Error && error.name === 'RequestUriError';
}

/**
 * `request_uri` の検査と取得の既定値。
 *
 * - maxLength: `request_uri` の長さの上限（文字。RFC 9101 §5.2 は 512 ASCII 文字を超えないことを勧める）
 * - timeoutMs: 取得のタイムアウト（ミリ秒）
 * - maxBytes: 応答の本文の上限（バイト）
 */
export const DEFAULT_REQUEST_URI_OPTIONS = {
  maxLength: 512,
  timeoutMs: 3000,
  maxBytes: 65536,
} as const;

/** {@link validateRequestUri} の宛先の方針。 */
export interface RequestUriPolicy {
  /** http と、ループバック・私設・リンクローカルのアドレスと localhost を許す（開発用）。既定 false。 */
  allowInsecure?: boolean;
  /** `request_uri` の長さの上限（文字）。既定 {@link DEFAULT_REQUEST_URI_OPTIONS}.maxLength */
  maxLength?: number;
}

/**
 * `uri` が OP の取得してよい `request_uri` なら `uri` をそのまま返し、そうでなければ `RequestUriError` を投げる。
 *
 * 長さが `policy.maxLength`（既定 512 文字）以内で、フラグメントを除いた URL が `validateClientJwksUri()` と同じ宛先の検査を通るものだけを通す。
 * つまり、空白と制御文字を含まない絶対 URL で、スキームが `https`（`policy.allowInsecure` のときは `http` も）で、userinfo を含まず、ホストが `localhost` やループバック・私設・リンクローカルの IP リテラルでない（`policy.allowInsecure` のときは通す）ものである。
 * フラグメントは含んでよい（OIDC Dynamic Client Registration 1.0 §2。取得のときに除く）。
 * 取得先を SSRF の踏み台にしないための検査である。
 *
 * @spec OIDC Core 1.0 §6.2
 * @spec RFC 9101 §5.2
 * @spec RFC 9101 §10.4.1
 * @throws {RequestUriError} 長すぎるとき、または宛先の検査を通らないとき
 */
export function validateRequestUri(uri: string, policy: RequestUriPolicy = {}): string {
  const maxLength = policy.maxLength ?? DEFAULT_REQUEST_URI_OPTIONS.maxLength;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new RequestUriError('request_uri must be an absolute URI');
  }
  if (uri.length > maxLength) {
    throw new RequestUriError(`request_uri must be at most ${maxLength} characters`);
  }
  try {
    validateClientJwksUri(requestUriFetchUrl(uri), { allowInsecure: policy.allowInsecure === true });
  } catch {
    throw new RequestUriError(
      policy.allowInsecure === true
        ? 'request_uri must be an absolute http or https URI'
        : 'request_uri must be an absolute https URI of a public host',
    );
  }
  return uri;
}

/**
 * `request_uri` からフラグメント（`#` から後ろ）を除いた、取得する URL を返す。
 *
 * フラグメントはクライアントが中身の識別（中身の SHA-256 ハッシュなど）に使うもので、取得の要求には含めない（RFC 3986 §3.5）。
 *
 * @spec OIDC Core 1.0 §6.2
 * @spec RFC 3986 §3.5
 */
export function requestUriFetchUrl(uri: string): string {
  const hashIndex = uri.indexOf('#');
  return hashIndex === -1 ? uri : uri.slice(0, hashIndex);
}

/**
 * `uri` がクライアントの登録した `request_uris` のどれかと完全に一致すれば true を返す。
 *
 * フラグメントも含めて文字列として比べる（`require_request_uri_registration`、OIDC Discovery 1.0 §3）。
 *
 * @spec OIDC Discovery 1.0 §3
 * @spec OIDC Dynamic Client Registration 1.0 §2
 */
export function matchesRegisteredRequestUri(uri: string, registered: readonly string[]): boolean {
  return registered.includes(uri);
}

/** {@link fetchRequestObjectByReference} の設定。省いた項目は {@link DEFAULT_REQUEST_URI_OPTIONS} の値になる。 */
export interface FetchRequestObjectOptions {
  /** 取得に使う fetch。既定は `globalThis.fetch`。egress プロキシ経由の fetch やテストのスタブを渡す */
  fetch?: typeof fetch;
  /** タイムアウト（ミリ秒）。既定 3000 */
  timeoutMs?: number;
  /** 本文の上限（バイト）。既定 65536 */
  maxBytes?: number;
  /** 宛先の方針（{@link validateRequestUri}） */
  policy?: RequestUriPolicy;
}

/**
 * `request_uri` の Request Object を 1 回取得し、前後の空白を除いた本文（JWT のコンパクト形式の文字列）を返す。
 *
 * 宛先を {@link validateRequestUri} で検査してから、フラグメントを除いた URL を `GET` で、`Accept: application/jwt`、`redirect: 'manual'`、`signal: AbortSignal.timeout(timeoutMs)` を付けて取得する。
 * リダイレクトには従わない。リダイレクト先は宛先の検査を通っていないからである。
 * 応答の `Content-Type` は見ない。
 * 本文が Request Object として正しいか（署名、alg）は、受け取った側が `resolveRequestObjectParams()` で確かめる。
 *
 * 200 以外（3xx を含む）の応答、`Content-Length` が上限を超える応答、読み進めて上限を超えた本文、UTF-8 でない本文、空の本文は、どれも `RequestUriError` にする。
 *
 * @spec OIDC Core 1.0 §6.2
 * @spec RFC 9101 §5.2.3
 * @spec RFC 9101 §10.4.1 / §10.4.2
 * @throws {RequestUriError} 宛先の検査、取得、応答の検査のどれかに失敗したとき
 */
export async function fetchRequestObjectByReference(
  uri: string,
  options: FetchRequestObjectOptions = {},
): Promise<string> {
  validateRequestUri(uri, options.policy);
  const fetchRequestObject = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_URI_OPTIONS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULT_REQUEST_URI_OPTIONS.maxBytes;

  let response: Response;
  try {
    // `redirect: 'error'` は、すべての実行環境の fetch が受け付けるわけではない（Cloudflare Workers）。
    // そのため `manual` にし、リダイレクトは 3xx（か opaqueredirect）の応答として下で拒否する。
    response = await fetchRequestObject(requestUriFetchUrl(uri), {
      method: 'GET',
      headers: { Accept: 'application/jwt' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new RequestUriError(`the request_uri request failed (${errorNameOf(e)})`);
  }

  if (response.status !== 200) {
    await discardBody(response);
    throw new RequestUriError(
      response.type === 'opaqueredirect'
        ? 'the request_uri answered a redirect'
        : `the request_uri answered HTTP ${response.status}`,
    );
  }
  const contentLength = response.headers.get('content-length')?.trim();
  if (contentLength !== undefined && /^[0-9]+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardBody(response);
    throw new RequestUriError(`the request_uri document exceeds ${maxBytes} bytes`);
  }

  const body = (await readBodyWithin(response, maxBytes)).trim();
  if (body === '') {
    throw new RequestUriError('the request_uri document is empty');
  }
  return body;
}

/** {@link resolveRequestUriParams} の設定。 */
export interface ResolveRequestUriOptions {
  /**
   * `request_uri` の Request Object を取得する。既定では使わず、呼び出し側が
   * {@link fetchRequestObjectByReference} に設定を添えて渡す。`RequestUriError` を投げると、
   * 理由を応答に出さない固定の文言の `invalid_request_uri` になる。
   */
  load: (uri: string) => Promise<string>;
  /**
   * クライアントが登録した `request_uris`。渡すと、この一覧と完全に一致しない `request_uri` を
   * 取得せずに拒否する（`require_request_uri_registration`、OIDC Discovery 1.0 §3）。
   * 省略すると照合しない。
   */
  registeredRequestUris?: readonly string[];
}

/**
 * `request_uri` の Request Object を取得し、`request_uri` を `request` に置き換えたパラメータを返す。
 *
 * `request_uri` がなければ、パラメータの複製をそのまま返し、`options.load` も呼ばない。
 * あれば、`request` との併用を拒否し、`options.registeredRequestUris` があれば登録との一致を確かめてから、`options.load` で取得する。
 * 返すパラメータは、`request_uri` を除き、取得した JWT を `request` に入れたもので、そのまま `resolveRequestObjectParams()` に渡す。
 * 署名、alg、署名なしの許可の規則は、値で渡した Request Object と同じになる（OIDC Core 1.0 §6.2）。
 *
 * どのエラーも、Request Object を検証する前の、`redirect_uri` を信用できない段階のものなので、リダイレクトしない `AuthorizationError` として投げる（OIDC Core 1.0 §3.1.2.6）。
 *
 * @spec OIDC Core 1.0 §6.2
 * @spec OIDC Core 1.0 §6.3
 * @spec RFC 9101 §5.2
 * @throws {AuthorizationError} `invalid_request`: `request` と `request_uri` を両方含むとき
 * @throws {AuthorizationError} `invalid_request_uri`: 登録されていない `request_uri` のとき、または取得できないとき（`options.load` が `RequestUriError` を投げたとき）
 */
export async function resolveRequestUriParams(
  params: AuthorizationRequestParams,
  options: ResolveRequestUriOptions,
): Promise<AuthorizationRequestParams> {
  const requestUri = params.request_uri;
  if (requestUri === undefined) {
    return { ...params };
  }
  // `request` と `request_uri` は一緒に使ってはならない（OIDC Core 1.0 §6.2、RFC 9101 §5）。
  if (params.request !== undefined) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'request and request_uri must not be used together',
    );
  }
  if (
    options.registeredRequestUris !== undefined &&
    !matchesRegisteredRequestUri(requestUri, options.registeredRequestUris)
  ) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequestUri,
      'request_uri is not registered for the client',
    );
  }

  let requestObject: string;
  try {
    requestObject = await options.load(requestUri);
  } catch (e) {
    // 失敗の理由は OP の内側のネットワークを探る手がかりになるので、応答に出さない。
    if (isRequestUriError(e)) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequestUri,
        'the request_uri could not be retrieved',
      );
    }
    throw e;
  }

  const { request_uri: _fetched, ...rest } = params;
  return { ...rest, request: requestObject };
}

/**
 * 投げられた値の名前（`TimeoutError`、`TypeError` など）を返し、名前がなければ `Error` を返す。
 *
 * エラーのメッセージに失敗の種類だけを載せ、元のメッセージは載せないために使う。
 */
function errorNameOf(error: unknown): string {
  return error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name: unknown }).name)
    : 'Error';
}

/** 読まない応答の本文を取り消し、取り消しに失敗しても何もしない。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 本文は使わないので、取り消しに失敗しても困らない。
  }
}

/**
 * 応答の本文を UTF-8 の文字列として読んで返し、`maxBytes` を超えた時点で読むのをやめて `RequestUriError` を投げる。
 *
 * 本文がなければ空文字を返す。
 * 読んでいるあいだに失敗したとき（タイムアウトのシグナルによる中断を含む）と、UTF-8 として読めないときも `RequestUriError` を投げる。
 *
 * @throws {RequestUriError} 本文が `maxBytes` を超えたとき、読めなかったとき、UTF-8 でないとき
 */
async function readBodyWithin(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestUriError(`the request_uri document exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (isRequestUriError(e)) throw e;
    // タイムアウトのシグナルは、読んでいる途中の本文も中断する。
    throw new RequestUriError(`the request_uri document could not be read (${errorNameOf(e)})`);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestUriError('the request_uri document is not UTF-8');
  }
}
