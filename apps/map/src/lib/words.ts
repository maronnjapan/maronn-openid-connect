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
      const said = writtenWords(node) ?? (call === undefined ? undefined : calleeSummary(call, source));
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
