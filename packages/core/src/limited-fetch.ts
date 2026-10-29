/**
 * HTTP GET の共通部品: `request_uri`（OIDC Core 1.0 §6.2.3）と `jwks_uri`
 * （OIDC Dynamic Client Registration 1.0 §2）のように、クライアントが登録した
 * URL を OP が取得しに行く処理が同じ制約で使う。
 *
 * - リダイレクトには従わない（登録した URL 以外へ辿らせない）
 * - タイムアウトと内容の上限を持つ。上限を超えた時点で読むのをやめる
 * - 200 以外の応答と空の内容は拒否する
 *
 * 失敗は {@link LimitedFetchError} で、`reason` が種別を表す。呼び出し側がそれを
 * 自分のエラー（固定文言）に写すので、URL や取得した内容はエラーに載らない。
 */

export type LimitedFetchFailure = 'network' | 'status' | 'size' | 'empty';

export class LimitedFetchError extends Error {
  constructor(readonly reason: LimitedFetchFailure) {
    super(`limited fetch failed: ${reason}`);
    this.name = 'LimitedFetchError';
  }
}

export interface LimitedFetchOptions {
  /** 取得に使う fetch。既定は globalThis.fetch。 */
  fetch?: typeof fetch;
  /** 送る Accept ヘッダ。 */
  accept: string;
  /** 内容の上限（UTF-8 バイト）。 */
  maxBytes: number;
  /** タイムアウト（ミリ秒）。 */
  timeoutMs: number;
}

/**
 * URL を GET し、内容を文字列で返す（前後の空白は除く）。
 *
 * @throws {LimitedFetchError} ネットワークエラーかタイムアウト（network）、200 以外（status）、
 *   上限超過（size）、空の内容（empty）
 */
export async function fetchTextWithLimits(url: URL, options: LimitedFetchOptions): Promise<string> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      headers: { Accept: options.accept },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new LimitedFetchError('network');
  }

  try {
    if (response.status !== 200) {
      throw new LimitedFetchError('status');
    }
    const declaredLength = Number(response.headers.get('Content-Length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      throw new LimitedFetchError('size');
    }
    const body = (await readBodyWithLimit(response, options.maxBytes)).trim();
    if (body.length === 0) {
      throw new LimitedFetchError('empty');
    }
    return body;
  } catch (error) {
    if (error instanceof LimitedFetchError) throw error;
    throw new LimitedFetchError('network');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 応答ボディを上限まで読む。上限を超えた時点で読むのをやめて拒否するので、
 * 大きな応答をメモリへ丸ごと載せない。
 */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new LimitedFetchError('size');
    }
    return new TextDecoder().decode(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new LimitedFetchError('size');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
