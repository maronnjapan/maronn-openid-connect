/**
 * `error_description` で使えない文字を `?` にして返す。
 *
 * 使える文字は、RFC 6749 §5.2 の `error-description = 1*( %x20-21 / %x23-5B / %x5D-7E )` が定める次の範囲である。
 * - `0x20`（空白）と `0x21`（`!`）
 * - `0x23` から `0x5B` まで（`0x22` の `"` を除く）
 * - `0x5D` から `0x7E` まで（`0x5C` の `\` を除く）
 *
 * 制御文字、二重引用符、バックスラッシュ、ASCII 以外の文字（`0x7F` 以上）を置き換えるのは、この値が JSON のボディにそのまま入り、ヘッダー（`WWW-Authenticate` の `Bearer` の `error_description` など）にも使われることがあるためである。
 * 文字は UTF-16 のコード単位ごとに調べるので、サロゲートペアで表す文字は `??` になる。
 *
 * @spec RFC 6749 §5.2
 */
export function sanitizeErrorDescription(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const allowed =
      code === 0x20 ||
      code === 0x21 ||
      (code >= 0x23 && code <= 0x5b) ||
      (code >= 0x5d && code <= 0x7e);
    result += allowed ? value[i] : '?';
  }
  return result;
}
