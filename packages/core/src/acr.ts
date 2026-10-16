/**
 * acr 値（Authentication Context Class Reference）の解析
 * OIDC Core 1.0 Section 2 / Section 3.1.2.1
 *
 * 認可リクエストの `acr_values` の検証と、トークンに載せる `acr` の選択で共有する。
 */

/**
 * OIDC Core 1.0 §3.1.2.1: 空白区切りの acr_values を、優先順のまま値の配列にする。
 * 連続した空白による空の要素は除く。値の文字は検査しない。
 */
export function parseAcrValues(acrValues: string): string[] {
  return acrValues.split(' ').filter((value) => value.length > 0);
}
