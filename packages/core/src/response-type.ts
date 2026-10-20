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
 */
export type AuthorizationResponseType = 'code' | 'id_token' | 'id_token token';

/**
 * OIDC Core 1.0 §3.2.2.1: Implicit Flow の response_type。
 * OAuth 2.0 の `token` 単独は ID Token を返さないため、OpenID Connect では使わない。
 */
export const IMPLICIT_RESPONSE_TYPES = ['id_token', 'id_token token'] as const satisfies readonly AuthorizationResponseType[];

/** response_type を構成する値のうち、OAuth 2.0 と OIDC Core 1.0 が定義するもの。 */
export type ResponseTypeValue = 'code' | 'id_token' | 'token';

/** {@link normalizeResponseType} が並べる値の順序。ここに無い値はこの後ろに並ぶ。 */
const RESPONSE_TYPE_VALUE_ORDER: readonly string[] = ['code', 'id_token', 'token'];

/**
 * OAuth 2.0 Multiple Response Type Encoding Practices §1.2: response_type は空白区切りの
 * 値の並びで、順序は問わない（`token id_token` と `id_token token` は同じ）。比較できるよう、
 * 値を code、id_token、token の順に並べ直し、1 つの空白で連結した文字列を返す。
 * 知らない値はその後ろに文字コード順で並べる。
 *
 * 同じ値の重複は取り除かない。重複のある response_type は、OP が扱うどの値とも一致しない。
 */
export function normalizeResponseType(responseType: string): string {
  const rank = (value: string): number => {
    const index = RESPONSE_TYPE_VALUE_ORDER.indexOf(value);
    return index === -1 ? RESPONSE_TYPE_VALUE_ORDER.length : index;
  };
  return responseType
    .split(' ')
    .filter((value) => value.length > 0)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .join(' ');
}

/**
 * response_type が value を含むかを返す。response_type が無ければ false。
 * 「code を含む response_type」（OIDC Core 1.0 §11）、「token または id_token を含む
 * response_type」（Multiple Response Type Encoding Practices §3 / §5）を判定するのに使う。
 */
export function responseTypeIncludes(
  responseType: string | undefined,
  value: ResponseTypeValue,
): boolean {
  return responseType !== undefined && responseType.split(' ').includes(value);
}

/**
 * OIDC Core 1.0 §3.2: response_type が Implicit Flow のもの（`id_token` または
 * `id_token token`。値の順序は問わない）かを返す。
 */
export function isImplicitResponseType(responseType: string | undefined): boolean {
  if (responseType === undefined) return false;
  return (IMPLICIT_RESPONSE_TYPES as readonly string[]).includes(normalizeResponseType(responseType));
}

/**
 * response_type の既定の応答モード（response_mode を指定しないリクエストへの返し方）。
 *
 * - `code`: query（Multiple Response Type Encoding Practices §2.1）
 * - `token` または `id_token` を含む response_type: fragment。query で返してはならない
 *   （同 §3 / §5 / §7。アクセストークンと ID Token はクエリに載せない）
 *
 * 成功の応答もエラーの応答もこの応答モードで返す（同 §3 / §5、OIDC Core 1.0 §3.2.2.6）。
 */
export function defaultResponseModeOf(responseType: string): 'query' | 'fragment' {
  return responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token')
    ? 'fragment'
    : 'query';
}
