/**
 * scope パラメータの解析
 * RFC 6749 Section 3.3
 */

/**
 * scope の値を空白で区切る。重複は除去しない。
 * 同意の照会など、保存済みの値を加工せずに渡す箇所で使う。
 */
export function splitScope(scopeValue: string): string[] {
  return scopeValue.split(' ').filter((value) => value.length > 0);
}

/**
 * RFC 6749 §3.3: 空白区切りの scope を集合として解析し、重複を挿入順のまま除去する。
 * 値の妥当性（openid の有無、許可範囲）は検査しない。
 */
export function parseScope(scopeValue: string): string[] {
  return [...new Set(splitScope(scopeValue))];
}
