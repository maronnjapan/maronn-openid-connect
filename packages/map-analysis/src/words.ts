/**
 * The words of the nodes of a flow tree, made from the code first: the code
 * of a node on one line, what a condition checks, what a statement does.
 * The comment above a statement and the JSDoc of what a call reaches replace
 * them when there are some (tree.ts), but nothing here needs either, so a
 * function nobody commented still reads.
 */

/** Collapse the whitespace of a text and cut it to a width, with an ellipsis. */
export function shorten(text: string, width = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length <= width ? flat : `${[...flat].slice(0, width - 1).join('')}…`;
}

/**
 * What a condition checks, in words (the rules the map has used since its
 * first version): `x === y` is "x が y と等しいか", `!x` is "x が偽として評価されるか",
 * `a.includes(b)` is "a に b が含まれるか". Empty for a condition the rules do not
 * read (the comment above it, or the JSDoc of the function it calls, says it).
 */
export function conditionWords(condition: string): string {
  const text = condition.replace(/\s+/g, ' ').trim();
  const includes = /^(!?)([\w.$?]+)\.(includes|startsWith|endsWith|has)\(([^()]*)\)$/.exec(text);
  if (includes) {
    const [, negate, value, method, expected] = includes;
    if (method === 'includes' || method === 'has') return `${value} に ${expected} が${negate ? '含まれないか' : '含まれるか'}`;
    const verb = method === 'startsWith' ? (negate ? '始まらないか' : '始まるか') : negate ? '終わらないか' : '終わるか';
    return `${value} が ${expected} で${verb}`;
  }
  const comparison = /^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/.exec(text);
  if (comparison) {
    const [, left, operator, right] = comparison;
    const phrases: Record<string, string> = {
      '===': 'と等しいか',
      '==': 'と等しいか',
      '!==': 'と異なるか',
      '!=': 'と異なるか',
      '>': 'より大きいか',
      '<': 'より小さいか',
      '>=': '以上か',
      '<=': '以下か',
    };
    if (right?.trim() === 'undefined' || right?.trim() === 'null') {
      const missing = operator === '===' || operator === '==';
      return `${left?.trim()} が ${missing ? '無いか' : 'あるか'}`;
    }
    return `${left?.trim()} が ${right?.trim()} ${phrases[operator as string]}`;
  }
  const instance = /^(.+) instanceof (.+)$/.exec(text);
  if (instance) return `${instance[1]} が ${instance[2]} 型の値か`;
  const property = /^(['"]?[\w$]+['"]?) in (.+)$/.exec(text);
  if (property) return `${property[2]} に ${property[1]} プロパティがあるか`;
  const typeOf = /^typeof (.+?) (===|!==) ['"](\w+)['"]$/.exec(text);
  if (typeOf) return `${typeOf[1]} の型が ${typeOf[3]} ${typeOf[2] === '===' ? 'か' : 'でないか'}`;
  const truthy = /^(!?)([\w.$?]+)$/.exec(text);
  if (truthy) return `${truthy[2]} が${truthy[1] ? '偽' : '真'}として評価されるか`;
  return '';
}

/** The words of a side of a decision. */
export const SIDE_WORDS: Readonly<Record<string, string>> = {
  true: '成立',
  false: '不成立',
  nullish: 'null または undefined',
  defined: '値あり',
  body: '繰り返す',
  skip: '繰り返さない',
  try: '例外なし',
  catch: '例外が起きたとき',
  finally: '最後に必ず',
  default: 'どの case にも当たらない',
};

/** The names a binding pattern binds, in order (`{ a, b: c, ...d }` → a, c, d). */
export function bindingNames(text: string): string[] {
  const names: string[] = [];
  const inner = text.replace(/^[[{]|[\]}]$/g, '');
  for (const part of splitTopLevel(inner)) {
    const entry = part.trim().replace(/^\.\.\./, '');
    if (entry === '') continue;
    const colon = topLevelIndex(entry, ':');
    const target = (colon === -1 ? entry : entry.slice(colon + 1)).split('=')[0]?.trim() ?? '';
    if (target.startsWith('{') || target.startsWith('[')) names.push(...bindingNames(target));
    else if (/^[A-Za-z_$][\w$]*$/.test(target)) names.push(target);
  }
  return names;
}

/** The parts of a list separated by commas outside brackets. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** The index of a character outside brackets, or -1. */
function topLevelIndex(text: string, wanted: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth -= 1;
    else if (char === wanted && depth === 0) return index;
  }
  return -1;
}

/**
 * What a statement that calls nothing of the catalog does, in a few words:
 * `const { a, b } = ...` takes out a and b, `x.y = ...` sets x.y. Empty when
 * the code says it as well (a call of the framework, for one).
 */
export function actionWords(code: string): string {
  const text = code.replace(/\s+/g, ' ').trim();
  const declaration = /^(?:export\s+)?(?:const|let|var)\s+([^=]+?)(?:\s*:\s*[^=]+)?\s*(=|;|$)/.exec(text);
  if (declaration) {
    const target = (declaration[1] as string).trim();
    if (target.startsWith('{') || target.startsWith('[')) {
      const names = bindingNames(target);
      return names.length === 0 ? '' : `${names.map((name) => `\`${name}\``).join('、')} を取り出す`;
    }
    const names = target.split(',').map((name) => name.trim().split(/\s*:/)[0]?.trim() ?? '').filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    if (names.length === 0) return '';
    return declaration[2] === '=' ? `${names.map((name) => `\`${name}\``).join('、')} を求める` : `${names.map((name) => `\`${name}\``).join('、')} を宣言する`;
  }
  const assignment = /^([\w$.[\]'"?]+)\s*(=|\+=|-=|\?\?=|\|\|=|&&=)\s*[^=]/.exec(text);
  if (assignment) return `\`${assignment[1]}\` に入れる`;
  if (/^delete\s/.test(text)) return `\`${shorten(text.slice(7), 40)}\` を消す`;
  if (/^(break|continue)\b/.test(text)) return text.startsWith('break') ? '抜ける' : '次へ進む';
  return '';
}

/** `throw new TokenError(TokenErrorCode.InvalidClient, ...)` → `TokenError(invalid_client)`, with the code the analysis read. */
export function errorWords(name: string, code: string | undefined): string {
  return code === undefined ? name : `${name}(${code})`;
}
