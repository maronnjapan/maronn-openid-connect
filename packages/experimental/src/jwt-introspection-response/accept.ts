/**
 * JWT Response for OAuth Token Introspection (RFC 9701) — Accept ヘッダ判定。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * RFC 9701 §4: リソースサーバーは Accept ヘッダを
 * `application/token-introspection+jwt` に設定して署名付き JWT の応答を要求する。
 * 本 OP はメディアタイプが明示された場合のみ JWT で応答し、ワイルドカード
 * （star-slash-star や `application/star`）は JWT 応答の要求と解釈しない。
 * ワイルドカードを JWT と解釈すると、汎用 HTTP クライアントが既定で送る
 * ワイルドカード Accept を持つ従来型リクエストの応答形式まで変わり、
 * RFC 7662 の後方互換が壊れるためである。
 */

/** RFC 9701 §4 / §5: 署名付きイントロスペクション応答のメディアタイプ。 */
export const TOKEN_INTROSPECTION_JWT_MEDIA_TYPE = 'application/token-introspection+jwt';

/**
 * `Accept` ヘッダーが JWT 形式を求めるなら true を返す。
 *
 * ヘッダーの値をカンマで区切り、各要素の `;` より前（メディアタイプ）を、前後の空白を除いて小文字にしてから {@link TOKEN_INTROSPECTION_JWT_MEDIA_TYPE} と比べる。
 * 完全に一致する要素が一つでもあれば true を返し、ヘッダーが `null`、`undefined`、空文字列のときは false を返す。
 * 完全一致で比べるので、`application/*` のようなワイルドカードは一致しない。
 *
 * `q` 値による優先順位は見ないので、`;q=0` で明示的に拒否した要素も、JWT 形式を求める要素として扱う。
 * RFC 9701 §4 には `q` 値の規定がなく、JWT 形式を受け取りたくないリソースサーバーは、このメディアタイプを送らなければよいためである。
 *
 * @spec RFC 9701 §4
 */
export function acceptsIntrospectionJwt(acceptHeader: string | null | undefined): boolean {
  if (acceptHeader === null || acceptHeader === undefined || acceptHeader === '') {
    return false;
  }
  return acceptHeader.split(',').some((element) => {
    const mediaType = element.split(';')[0]?.trim().toLowerCase();
    return mediaType === TOKEN_INTROSPECTION_JWT_MEDIA_TYPE;
  });
}
