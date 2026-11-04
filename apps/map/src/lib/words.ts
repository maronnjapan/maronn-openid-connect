/**
 * The words of a row of the outline: one line of natural language per node,
 * read in the order the code runs, so a reader can follow a flow without
 * reading its code.
 *
 * The words come from what the repository already requires or writes: the
 * label of a step, the JSDoc of the function a call reaches (the first line
 * is linted), the JSDoc of an interface member, and the comment above a
 * statement. Where none of these says what a statement does (a variable, a
 * condition written in code), the row shows the code itself: words made up
 * from the code read worse than the code.
 */
import type { MapData, TreeNode } from '../types';

/** One line for a row: natural language, or the code where there are no words. */
export interface Words {
  text: string;
  /** The text is code (monospace), not words. */
  code: boolean;
  /** A tag before the text: how the row ends the flow. */
  tag?: '終わり' | '失敗';
}

/** What the words of a node may come from. */
export type WordSource = Pick<MapData, 'functions' | 'members'>;

/** The first sentence of a text (to its first `。`), on one line. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  const end = flat.indexOf('。');
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** The first sentence of the JSDoc of what a call reaches: a function of the catalog or an interface member; undefined for anything else. */
export function calleeSummary(node: TreeNode, source: WordSource): string | undefined {
  const target = node.target;
  const summary = target?.kind === 'function' ? source.functions[target.id]?.summary : target?.kind === 'member' ? source.members[target.id]?.summary : undefined;
  return summary === undefined || summary.trim() === '' ? undefined : firstSentence(summary);
}

/** Words written for this statement by a person: the comment above it, or the JSDoc of the predicate a condition calls. */
function writtenWords(node: TreeNode): string | undefined {
  return node.text !== undefined && (node.from === 'comment' || node.from === 'doc') ? firstSentence(node.text) : undefined;
}

const words = (text: string, tag?: Words['tag']): Words => ({ text, code: false, ...(tag === undefined ? {} : { tag }) });
const code = (text: string, tag?: Words['tag']): Words => ({ text: text.replace(/\s+/g, ' ').trim(), code: true, ...(tag === undefined ? {} : { tag }) });

/**
 * The line of a node (see the module comment). `call` is the call the row
 * stands for besides the node itself: the call evaluated last before a
 * condition or a return (`if (!isFormUrlEncoded(request))`,
 * `return respondToken(c, response)`), whose JSDoc says what a return answers.
 */
export function nodeWords(node: TreeNode, source: WordSource, call?: TreeNode): Words {
  switch (node.kind) {
    case 'block':
      return words(node.step?.label ?? node.text ?? node.code);
    case 'try':
      return words('ここから例外を捕まえる');
    case 'end':
      return words('最後まで進んで終わる', '終わり');
    case 'call': {
      const summary = calleeSummary(node, source) ?? writtenWords(node);
      return summary === undefined ? code(node.code) : words(summary);
    }
    case 'return': {
      const said = writtenWords(node) ?? (call === undefined ? undefined : calleeSummary(call, source)) ?? returnedWords(node.code);
      return said === undefined ? code(node.code, '終わり') : words(said, '終わり');
    }
    case 'throw': {
      const said = writtenWords(node);
      if (said !== undefined) return words(said, '失敗');
      return node.error === undefined ? code(node.code, '失敗') : words(`\`${node.error}\` を投げる`, '失敗');
    }
    case 'cond-expr':
      // Its words say what it does on each side (`x が無ければ f() を呼ぶ`), made from the code but worth reading.
      return node.text === undefined ? code(node.code) : words(firstSentence(node.text));
    default: {
      const said = writtenWords(node);
      return said === undefined ? code(node.code) : words(said);
    }
  }
}

/** The calls evaluated before a node, split into the one its row stands for (the last, when it is a plain call and the node is not a call itself) and the others, which keep rows of their own. */
export function splitPre(node: TreeNode): { call?: TreeNode; others: TreeNode[] } {
  const pre = node.pre ?? [];
  const last = pre[pre.length - 1];
  if (node.kind === 'call' || last === undefined || last.kind !== 'call' || last.branches !== undefined) return { others: [...pre] };
  return { call: last, others: pre.slice(0, -1) };
}

/** The words of a side read as one line after an arrow: what it calls and how it ends (`→ 終わり: トークンを返す`), `何もしない` for nothing. */
export function sideWords(nodes: readonly TreeNode[], source: WordSource): string {
  if (nodes.length === 0) return '何もしない';
  return nodes
    .map((node) => {
      const said = nodeWords(node, source, splitPre(node).call);
      const text = said.code ? `\`${said.text}\`` : said.text.replace(/。$/, '');
      return said.tag === undefined ? text : `${said.tag}: ${text}`;
    })
    .join('、');
}

/** The parts of a list separated by commas outside brackets and quotes. */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const char of text) {
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if ('([{<'.includes(char)) depth += 1;
    else if (')]}>'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** The names a binding pattern binds (`{ a, b: c, ...d }` → a, c, d; nested patterns included). */
function patternNames(pattern: string): string[] {
  const inner = pattern.trim().replace(/^[[{]|[\]}]$/g, '');
  return topLevel(inner).flatMap((part) => {
    const entry = part.replace(/^\.\.\./, '');
    const colon = entry.search(/:(?![^{[]*[}\]])/);
    const target = (colon === -1 ? entry : entry.slice(colon + 1)).split('=')[0]?.trim() ?? '';
    if (target.startsWith('{') || target.startsWith('[')) return patternNames(target);
    return /^[A-Za-z_$][\w$]*$/.test(target) ? [target] : [];
  });
}

/** The bracketed pattern at the start of a text, with its brackets (`{ a, b } = x` → `{ a, b }`). */
function leadingPattern(text: string): string | undefined {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return undefined;
}

/**
 * What a statement binds or sets, from its code: the names a declaration
 * binds (`const { a, b: c } = x` → `a`, `c`), or the target of an
 * assignment (`x.y = 1` → `x.y`); empty for anything else.
 */
export function boundNames(statement: string): { declared: string[]; assigned: string[] } {
  const text = statement.replace(/\s+/g, ' ').trim();
  const declaration = /^(?:export\s+)?(?:const|let|var)\s+/.exec(text);
  if (declaration) {
    const rest = text.slice(declaration[0].length);
    const pattern = rest.startsWith('{') || rest.startsWith('[') ? leadingPattern(rest) : undefined;
    if (pattern !== undefined) return { declared: patternNames(pattern), assigned: [] };
    const head = rest.split('=')[0] ?? '';
    return { declared: topLevel(head).map((part) => part.split(':')[0]?.trim() ?? '').filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)), assigned: [] };
  }
  const assignment = /^([\w$.[\]'"?]+)\s*(?:=(?!=)|\+=|-=|\*=|\|=|&=|\?\?=|\|\|=|&&=)/.exec(text);
  return { declared: [], assigned: assignment ? [assignment[1] as string] : [] };
}

/** The words of a return with nothing written for it, made from simple code: what it returns (`return { a, b }` → `a`、`b` を返す, `return x` → `x` を返す); undefined for anything else. */
export function returnedWords(statement: string): string | undefined {
  const value = statement.replace(/\s+/g, ' ').trim().replace(/^return\s*/, '').replace(/;$/, '').trim();
  if (value === '') return 'ここで終わる';
  if (/^[A-Za-z_$][\w$.]*$/.test(value)) return `\`${value}\` を返す`;
  if (value.startsWith('{') && value.endsWith('}')) {
    const keys = topLevel(value.slice(1, -1)).map((part) => (part.startsWith('...') ? part : (part.split(':')[0] ?? '').trim()));
    if (keys.length > 0 && keys.every((key) => /^(\.\.\.)?[A-Za-z_$][\w$.]*$/.test(key))) return `${keys.map((key) => `\`${key}\``).join('、')} を返す`;
  }
  return undefined;
}

/**
 * The words of a run of statements that say nothing in words (variables,
 * settings), on one line: what they bind (`\`a\`、\`b\` を用意する`), what they set
 * (`\`x.y\` に入れる`), or both with the rest as code (`処理: \`seen.add(key)\`、…`).
 */
export function runWords(nodes: readonly TreeNode[]): Words {
  const names = nodes.map((node) => ({ node, ...boundNames(node.code) }));
  const declared = names.flatMap((entry) => entry.declared);
  const assigned = names.flatMap((entry) => entry.assigned);
  const others = names.filter((entry) => entry.declared.length === 0 && entry.assigned.length === 0).map((entry) => entry.node.code.replace(/\s+/g, ' ').trim());
  const quote = (items: readonly string[]) => items.map((item) => `\`${item}\``).join('、');
  if (others.length === 0 && assigned.length === 0 && declared.length > 0) return words(`${quote(declared)} を用意する`);
  if (others.length === 0 && declared.length === 0 && assigned.length > 0) return words(`${quote(assigned)} に入れる`);
  return words(`処理: ${quote([...declared, ...assigned, ...others])}`);
}
