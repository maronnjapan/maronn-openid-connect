/**
 * scope パラメータの解析
 * RFC 6749 Section 3.3
 */

/**
 * `scope` の値を半角空白で分けた配列を返す。
 *
 * 空白が続いてできる空の値は取り除くが、重複は取り除かない。
 * 同意の照会のように、保存済みの値を変えずに渡す箇所で使う。
 */
export function splitScope(scopeValue: string): string[] {
  return scopeValue.split(' ').filter((value) => value.length > 0);
}

/**
 * `scope` の値を半角空白で分け、重複を除いた配列を返す。
 *
 * スコープの値は集合として扱うので、同じ値は最初に現れた位置にだけ残し、値の順序は変えない（RFC 6749 §3.3）。
 * 空白が続いてできる空の値も取り除く。
 * 値の妥当性（`openid` があるか、許された範囲か）は確かめない。
 *
 * @spec RFC 6749 §3.3
 */
export function parseScope(scopeValue: string): string[] {
  return [...new Set(splitScope(scopeValue))];
}

/**
 * クライアントに登録されていないスコープを返す。
 *
 * `requested` のうち、クライアントの登録メタデータ `scope`（クライアントが要求してよいスコープの一覧）にない値を、要求の順に返す（RFC 7591 §2）。
 * `registered` が `undefined`（登録がない）クライアントにはスコープを制限しないので、空の配列を返す。
 *
 * @spec RFC 7591 §2
 */
export function findUnregisteredClientScopes(
  requested: readonly string[],
  registered: readonly string[] | undefined,
): string[] {
  if (registered === undefined) return [];
  return requested.filter((scope) => !registered.includes(scope));
}
