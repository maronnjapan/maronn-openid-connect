/**
 * Experimental 機能がリポジトリ内のどこに現れるかを検出するための純粋関数群。
 *
 * ここでの検出は「人間がレビューすべき場所の地図」を作るためのもので、
 * 判定はしない。多少の見落とし・拾いすぎよりも、決定的で説明可能な
 * ルールであることを優先している。
 */

/** kebab-case の feature-id を camelCase へ変換する（token-exchange → tokenExchange）。 */
export function kebabToCamel(id) {
  return id.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** camelCase を PascalCase へ変換する（tokenExchange → TokenExchange）。 */
export function camelToPascal(camel) {
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * feature-id への言及回数を数える。
 *
 * 3 つのルールの和集合（開始位置で重複排除）:
 *  1. 単語としての id（大文字小文字を無視）: `par` / `PAR` / `'token-exchange'`
 *     — `params` や `parse` のような部分一致は単語境界で除外される
 *  2. camelCase 識別子の先頭としての id: `parStore` / `jarmConfig` / `tokenExchangeStep`
 *  3. PascalCase 識別子の先頭としての id: `ParError` / `TokenExchangeRequest`
 *     — 直後が大文字・数字・アンダースコアの場合だけ一致させ、
 *       `ParseError` のような別単語を除外する
 */
export function countFeatureMentions(content, featureId) {
  const camel = kebabToCamel(featureId);
  const pascal = camelToPascal(camel);

  const patterns = [
    new RegExp(`\\b${escapeRegExp(featureId)}\\b`, 'gi'),
    new RegExp(`\\b${escapeRegExp(camel)}(?=[A-Z0-9_]|\\b)`, 'g'),
    new RegExp(`\\b${escapeRegExp(pascal)}(?=[A-Z0-9_]|\\b)`, 'g'),
  ];

  const positions = new Set();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      positions.add(match.index);
    }
  }
  return positions.size;
}

/**
 * サンプルの generate スクリプトから `--enable <feature>` の値を列挙する。
 * 見つからない・スクリプトが無い場合は空配列。
 */
export function parseEnabledFeatures(generateScript) {
  if (typeof generateScript !== 'string') return [];
  return [...generateScript.matchAll(/--enable\s+([a-z0-9-]+)/g)].map((m) => m[1]);
}

/**
 * generate スクリプトの `--output <dir>` を、先頭の `./` を除いた形で返す。
 * 見つからない場合は null。
 */
export function parseOutputDir(generateScript) {
  if (typeof generateScript !== 'string') return null;
  const match = generateScript.match(/--output\s+(\S+)/);
  if (!match) return null;
  return match[1].replace(/^\.\//, '');
}

/** 人間に見せるための行数（末尾改行は 1 行に数えない）。 */
export function countLines(content) {
  if (content === '') return 0;
  const lines = content.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * specification.md の `- **準拠仕様**: X` 行から仕様名を取り出す。
 * 見つからない・内容が無い場合は null。
 */
export function parseSpecName(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/^- \*\*準拠仕様\*\*:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}
