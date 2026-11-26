/**
 * DPoP proof の `htu` と、リクエストの URI の比較。
 *
 * `htu` は、DPoP proof を送るリクエストの URI からクエリとフラグメントを除いたものである（RFC 9449 §4.2）。
 * 比較の前に、構文に基づく正規化（RFC 3986 §6.2.2）とスキームに基づく正規化（RFC 3986 §6.2.3）を行う（RFC 9449 §4.3 の SHOULD）。
 */

/** 予約されていない文字（RFC 3986 §2.3）。パーセントエンコードされていても、そのままの文字と同じものとして扱う。 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * URI を、DPoP の `htu` として比べる形に正規化して返す。
 *
 * クエリとフラグメントを除き、次の正規化を行う。
 * - スキームとホストを小文字にする、スキームの既定のポートを除く、空のパスを `/` にする、`.` と `..` のセグメントを取り除く（WHATWG URL の解析が行う。RFC 3986 §6.2.2.1 / §6.2.2.3 / §6.2.3）
 * - パーセントエンコーディングの 16 進数を大文字にし、予約されていない文字のパーセントエンコーディングを元の文字に戻す（RFC 3986 §6.2.2.1 / §6.2.2.2）
 *
 * `http` と `https` 以外のスキームや、URI として解析できない値は `undefined` を返す。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 3986 §6.2.2
 * @spec RFC 3986 §6.2.3
 */
export function normalizeDpopHtu(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const path = url.pathname.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
  const userinfo = url.username === '' && url.password === '' ? '' : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`;
  return `${url.protocol}//${userinfo}${url.host}${path}`;
}
