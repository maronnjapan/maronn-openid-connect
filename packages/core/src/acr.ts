/**
 * acr 値（Authentication Context Class Reference）の解析
 * OIDC Core 1.0 Section 2 / Section 3.1.2.1
 *
 * 認可リクエストの `acr_values` の検証と、トークンに載せる `acr` の選択で共有する。
 */

/**
 * `acr_values` を空白で分け、元の順序のまま配列で返す。
 *
 * 元の順序は、要求する値の優先順である。
 * 区切りは半角空白だけで、空白が連続してできる空の要素は取り除く。
 * 値に使われている文字は検査しない。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export function parseAcrValues(acrValues: string): string[] {
  return acrValues.split(' ').filter((value) => value.length > 0);
}
