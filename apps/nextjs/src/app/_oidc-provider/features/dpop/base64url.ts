/**
 * base64url（RFC 4648 §5、パディングなし）の符号化と復号。
 *
 * JWS（RFC 7515）と JWK Thumbprint（RFC 7638）が使う形だけを扱う。
 * 復号は正規の符号（RFC 4648 §3.5）だけを受け付けるので、同じバイト列を表す文字列は一つに決まる。
 */

/** base64url の文字だけからなる文字列（パディングなし）。 */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * バイト列を、パディングのない base64url の文字列にして返す。
 *
 * 末尾の文字の余りのビットは 0 にする（正規の符号、RFC 4648 §3.5）。
 *
 * @spec RFC 4648 §5
 * @spec RFC 7515 §2
 */
export function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * パディングのない正規の base64url の文字列をバイト列に戻して返す。
 *
 * 次の文字列には `undefined` を返す。
 * - base64url の文字以外を含む文字列や、パディング（`=`）付きの文字列
 * - 長さを 4 で割った余りが 1 の文字列（どのバイト列の符号でもない）
 * - 末尾の文字の余りのビットが 0 でない文字列（`Zh` は `f` を表すが、正規の符号は `Zg`、RFC 4648 §3.5）
 *
 * @spec RFC 4648 §3.5
 * @spec RFC 4648 §5
 * @spec RFC 7515 §2
 */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // 符号にし直して同じ文字列に戻るのは、余りのビットが 0 の正規の符号だけである。
  return encodeBase64Url(bytes) === value ? bytes : undefined;
}
