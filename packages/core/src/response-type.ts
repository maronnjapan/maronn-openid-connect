/**
 * response_type の値の比較と分類
 * OAuth 2.0 Multiple Response Type Encoding Practices §1.2 / §2.1 / §3 / §5、OIDC Core 1.0 §3
 *
 * response_type は空白区切りの値の並びで、値の順序は問わない。認可エンドポイントの
 * 検証、クライアント登録との照合、認可レスポンスの返し方の判断で同じ規則を使う。
 */

/**
 * この OP が認可エンドポイントで扱う response_type（{@link normalizeResponseType} の形）。
 * - `code`: Authorization Code Flow（OIDC Core 1.0 §3.1）
 * - `id_token` / `id_token token`: Implicit Flow（OIDC Core 1.0 §3.2）
 * - `code id_token` / `code token` / `code id_token token`: Hybrid Flow（OIDC Core 1.0 §3.3）
 */
export type AuthorizationResponseType =
  | 'code'
  | 'id_token'
  | 'id_token token'
  | 'code id_token'
  | 'code token'
  | 'code id_token token';

/**
 * OIDC Core 1.0 §3.2.2.1: Implicit Flow の response_type。
 * OAuth 2.0 の `token` 単独は ID Token を返さないため、OpenID Connect では使わない。
 */
export const IMPLICIT_RESPONSE_TYPES = ['id_token', 'id_token token'] as const satisfies readonly AuthorizationResponseType[];

/**
 * OIDC Core 1.0 §3.3.1.1: Hybrid Flow の response_type。認可コードと一緒に、認可エンドポイントが
 * ID Token（`code id_token`）、アクセストークン（`code token`）、または両方（`code id_token token`）
 * を返す（OAuth 2.0 Multiple Response Type Encoding Practices §5）。
 */
export const HYBRID_RESPONSE_TYPES = ['code id_token', 'code token', 'code id_token token'] as const satisfies readonly AuthorizationResponseType[];

/** response_type を構成する値のうち、OAuth 2.0 と OIDC Core 1.0 が定義するもの。 */
export type ResponseTypeValue = 'code' | 'id_token' | 'token';

/** {@link normalizeResponseType} が並べる値の順序。ここに無い値はこの後ろに並ぶ。 */
const RESPONSE_TYPE_VALUE_ORDER: readonly string[] = ['code', 'id_token', 'token'];

/**
 * `response_type` の値を決まった順に並べ直して返す。
 *
 * `response_type` は半角空白で区切った値の並びで、値の順序は問わない（`token id_token` と `id_token token` は同じ）。
 * 比べられるように、値を `code`、`id_token`、`token` の順に並べ、半角空白 1 つでつないだ文字列を返す。
 * これら以外の値は、その後ろに文字コード順で並べる。
 *
 * 同じ値が重なっていても取り除かない。
 * 空白が続いているときや前後に空白があるとき（1 つの半角空白で区切る形に反する値、RFC 6749 §3.1.1）にできる空の値も、これら以外の値として残す。
 * どちらの場合も、並べ直した文字列は OP が扱うどの `response_type` とも一致しない。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §1.2
 * @spec RFC 6749 §3.1.1
 */
export function normalizeResponseType(responseType: string): string {
  const rank = (value: string): number => {
    const index = RESPONSE_TYPE_VALUE_ORDER.indexOf(value);
    return index === -1 ? RESPONSE_TYPE_VALUE_ORDER.length : index;
  };
  return responseType
    .split(' ')
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .join(' ');
}

/**
 * `response_type` が `value` を含むなら true を返す。
 *
 * `responseType` を半角空白で分けた値のどれかが `value` と一致すれば true を返し、`responseType` が `undefined` なら false を返す。
 * 「`code` を含む `response_type`」（OIDC Core 1.0 §11）や、「`token` か `id_token` を含む `response_type`」（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5）を判定するのに使う。
 */
export function responseTypeIncludes(
  responseType: string | undefined,
  value: ResponseTypeValue,
): boolean {
  return responseType !== undefined && responseType.split(' ').includes(value);
}

/**
 * インプリシットフローの値なら true を返す。
 *
 * `responseType` が、値の順序を問わずに `id_token` か `id_token token` と一致すれば true を返す。
 * `responseType` が `undefined` なら false を返す。
 *
 * @spec OIDC Core 1.0 §3.2
 */
export function isImplicitResponseType(responseType: string | undefined): boolean {
  if (responseType === undefined) return false;
  return (IMPLICIT_RESPONSE_TYPES as readonly string[]).includes(normalizeResponseType(responseType));
}

/**
 * ハイブリッドフローの値なら true を返す。
 *
 * `responseType` が、値の順序を問わずに `code id_token`、`code token`、`code id_token token` のどれかと一致すれば true を返す。
 * `responseType` が `undefined` なら false を返す。
 *
 * @spec OIDC Core 1.0 §3.3
 */
export function isHybridResponseType(responseType: string | undefined): boolean {
  if (responseType === undefined) return false;
  return (HYBRID_RESPONSE_TYPES as readonly string[]).includes(normalizeResponseType(responseType));
}

/**
 * `response_type` の既定のレスポンスモードを返す。
 *
 * 既定のレスポンスモードは、`response_mode` を指定しないリクエストに認可レスポンスを返すときの返し方である。
 * - `token` か `id_token` を含む `response_type`（インプリシットフローとハイブリッドフロー）には `fragment` を返す。
 * - それ以外の `response_type`（`code` など）には `query` を返す（OAuth 2.0 Multiple Response Type Encoding Practices §2.1）。
 *
 * `token` か `id_token` を含む `response_type` では、アクセストークンと ID トークンをクエリに含めないように、`query` で返してはならない（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5、§7）。
 * 成功の認可レスポンスもエラーレスポンスも、このレスポンスモードで返す（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5、OIDC Core 1.0 §3.2.2.6、§3.3.2.6）。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §2.1
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §3
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §5
 */
export function defaultResponseModeOf(responseType: string): 'query' | 'fragment' {
  return responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token')
    ? 'fragment'
    : 'query';
}
