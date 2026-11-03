/**
 * ホスト名がループバックを指すなら true を返す。
 *
 * true を返すのは、`localhost`、`[::1]`、`127.x.x.x` の形の IPv4 アドレスである。
 * 引数には `URL.hostname` の値を渡す。
 * `URL.hostname` は IPv4 アドレスのほかの書き方を正規化した値を返すので、ここでは 127.0.0.0/8 の正規の表記だけを受け付ければよい。
 * ループバックの IPv4 アドレスは `127.0.0.1` に限らず、どれを使ってもよい（RFC 8252 §7.3）。
 *
 * @spec RFC 8252 §7.3
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
