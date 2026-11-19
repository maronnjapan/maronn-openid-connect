/**
 * base64url（RFC 4648 §5、パディングなし）の符号化と復号。
 *
 * JWS（RFC 7515）と JWK Thumbprint（RFC 7638）が使う形だけを扱う。
 */

/** base64url の文字だけからなる文字列（パディングなし）。 */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * バイト列を、パディングのない base64url の文字列にして返す。
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
 * パディングのない base64url の文字列をバイト列に戻して返す。
 *
 * base64url の文字以外を含む文字列、パディング（`=`）付きの文字列、長さを 4 で割った余りが 1 の文字列（どのバイト列の符号でもない）は、`undefined` を返す。
 *
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
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
