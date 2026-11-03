/**
 * What a pull request did to a frame, node by node: the tree before and the
 * tree after matched list by list, and inside a changed node, the parts of
 * its code that changed.
 *
 * - In each list (the siblings of one parent), the nodes of the same kind
 *   and identity (the callee of a call, the code of a condition) are matched
 *   in order (the longest common subsequence); between two matches, the
 *   nodes left over of the same kind are matched in order too. A matched
 *   pair whose own code differs is modified; the nodes left are added
 *   (after) and removed (before, placed behind the node they followed).
 * - A modified node's code is compared token by token: one token changed is
 *   "`<` を `<=` に変えた", an argument more or less is "引数 `issuedAt` を足した",
 *   anything larger is "式を書き換えた" with the code before and after.
 * - The hunks of the text diff go on the smallest node whose lines hold
 *   them; the lines of the nodes cover the frame, so every hunk has one.
 */
import type { DiffHunk, ExprChange, FlowTree, FrameChange, RemovedNode, TreeNode } from './model.js';
import { shorten, splitTopLevel } from './words.js';

/** The categories a change is counted in. */
const CATEGORY: Record<string, string> = {
  call: 'call',
  action: 'action',
  if: 'condition',
  switch: 'condition',
  'cond-expr': 'condition',
  loop: 'loop',
  try: 'try',
  return: 'exit',
  throw: 'exit',
  block: 'step',
  end: 'end',
};

/** The words of a category in a summary. */
const CATEGORY_WORDS: Record<string, string> = {
  call: '呼び出し',
  action: '処理',
  condition: '条件',
  loop: '繰り返し',
  try: '例外の捕捉',
  exit: '終わり',
  step: 'ステップ',
};

// ---- tokens

/** The tokens of code: words, numbers, strings, and operators (the longest first). */
export function tokens(code: string): string[] {
  const out: string[] = [];
  const operators = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
  let index = 0;
  while (index < code.length) {
    const char = code[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      let end = index + 1;
      while (end < code.length && code[end] !== char) end += code[end] === '\\' ? 2 : 1;
      out.push(code.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const word = /^[\p{L}\p{N}_$]+/u.exec(code.slice(index));
    if (word !== null) {
      out.push(word[0]);
      index += word[0].length;
      continue;
    }
    const operator = operators.find((candidate) => code.startsWith(candidate, index));
    out.push(operator ?? char);
    index += (operator ?? char).length;
  }
  return out;
}

/** The pairs of equal items of two lists, in order (longest common subsequence): [index in a, index in b]. */
export function matchInOrder<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i * width + j] = equal(a[i] as T, b[j] as T) ? (common[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i] as T, b[j] as T)) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) i += 1;
    else j += 1;
  }
  return pairs;
}

/** The arguments of a call in its code (`f(a, b)` → a, b), or undefined for code that is not one call. */
function argumentsOf(code: string): { callee: string; args: string[] } | undefined {
  const open = code.indexOf('(');
  if (open === -1 || !code.endsWith(')')) return undefined;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0 && index !== code.length - 1) return undefined;
    }
  }
  return { callee: code.slice(0, open).trim(), args: splitTopLevel(code.slice(open + 1, -1)).map((arg) => arg.trim()) };
}

/** The call a statement makes as its value (`const x = await f(a)` → `f(a)`). */
function callIn(code: string): string {
  return code.replace(/^(?:export\s+)?(?:const|let|var)\s+[^=]+=\s*/, '').replace(/^(?:return|throw)\s+/, '').replace(/^await\s+/, '').replace(/;$/, '').trim();
}

/** The changes inside the code of a node: what was replaced, added and removed (see the module comment). */
export function expressionChanges(before: string, after: string): ExprChange[] {
  if (before === after) return [];
  const beforeCall = argumentsOf(callIn(before));
  const afterCall = argumentsOf(callIn(after));
  if (beforeCall !== undefined && afterCall !== undefined) {
    const changes: ExprChange[] = [];
    if (beforeCall.callee !== afterCall.callee) changes.push({ text: `\`${shorten(beforeCall.callee, 40)}()\` を \`${shorten(afterCall.callee, 40)}()\` に置き換えた`, before: beforeCall.callee, after: afterCall.callee });
    const pairs = matchInOrder(beforeCall.args, afterCall.args, (x, y) => x === y);
    const keptBefore = new Set(pairs.map(([i]) => i));
    const keptAfter = new Set(pairs.map(([, j]) => j));
    const added = afterCall.args.filter((_arg, index) => !keptAfter.has(index));
    const removed = beforeCall.args.filter((_arg, index) => !keptBefore.has(index));
    if (added.length === 1 && removed.length === 1) {
      changes.push(...tokenChanges(removed[0] as string, added[0] as string).map((change) => ({ ...change, text: `引数の ${change.text}` })));
    } else {
      for (const arg of added) changes.push({ text: `引数 \`${shorten(arg, 40)}\` を足した`, after: arg });
      for (const arg of removed) changes.push({ text: `引数 \`${shorten(arg, 40)}\` を消した`, before: arg });
    }
    const binding = (code: string) => /^(?:const|let|var)\s+([^=]+?)\s*=/.exec(code)?.[1]?.trim();
    if (binding(before) !== binding(after)) changes.push({ text: `受け取る名前を \`${shorten(binding(before) ?? '', 40)}\` から \`${shorten(binding(after) ?? '', 40)}\` に変えた`, before: binding(before) ?? '', after: binding(after) ?? '' });
    if (changes.length > 0) return changes;
  }
  return tokenChanges(before, after);
}

/** The changes between two pieces of code, token by token. */
function tokenChanges(before: string, after: string): ExprChange[] {
  const a = tokens(before);
  const b = tokens(after);
  const pairs = matchInOrder(a, b, (x, y) => x === y);
  // The runs of tokens between the matches.
  const runs: Array<{ before: string[]; after: string[] }> = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) runs.push({ before: a.slice(i, pi), after: b.slice(j, pj) });
    i = pi + 1;
    j = pj + 1;
  }
  const changed = runs.reduce((count, run) => count + Math.max(run.before.length, run.after.length), 0);
  if (runs.length > 3 || changed > Math.max(4, Math.min(a.length, b.length) / 2)) {
    return [{ text: '式を書き換えた', before: shorten(before, 120), after: shorten(after, 120) }];
  }
  return runs.map((run) => {
    const was = run.before.join(' ');
    const now = run.after.join(' ');
    if (was === '') return { text: `\`${shorten(now, 40)}\` を足した`, after: now };
    if (now === '') return { text: `\`${shorten(was, 40)}\` を消した`, before: was };
    return { text: `\`${shorten(was, 40)}\` を \`${shorten(now, 40)}\` に変えた`, before: was, after: now };
  });
}

// ---- trees

/** What identifies a node across a change: its kind and its callee, step, or code. */
function identity(node: TreeNode, own: ReadonlyMap<TreeNode, string>): string {
  switch (node.kind) {
    case 'call':
      return `call:${node.target?.kind === 'untraceable' ? `?${node.target.why}` : (node.target?.id ?? node.code)}`;
    case 'block':
      return `block:${node.step?.id ?? node.code}`;
    case 'try':
    case 'end':
      return node.kind;
    default:
      return `${node.kind}:${own.get(node) ?? node.code}`;
  }
}

interface Diff {
  marks: FrameChange['marks'];
  removed: RemovedNode[];
  exprs: FrameChange['exprs'];
  summary: string[];
  counts: Record<string, number>;
}

/** The name of a node in a summary: `\`verifyClientSecret()\` の呼び出し`, `条件 \`!client\``. */
function nodeWords(node: TreeNode): string {
  switch (node.kind) {
    case 'call':
      return `\`${node.code.replace(/^.*?=\s*(?:await\s+)?/, '').replace(/\(.*$/, '')}()\` の呼び出し`;
    case 'if':
    case 'cond-expr':
      return `条件 \`${shorten(node.subject ?? node.code, 50)}\``;
    case 'switch':
      return `分岐 \`${shorten(node.subject ?? node.code, 50)}\``;
    case 'loop':
      return `繰り返し \`${shorten(node.code, 50)}\``;
    case 'try':
      return '例外の捕捉';
    case 'return':
    case 'throw':
      return `\`${shorten(node.code, 50)}\``;
    case 'block':
      return `ステップ「${node.step?.label ?? node.code}」`;
    default:
      return `処理 \`${shorten(node.code, 50)}\``;
  }
}

function count(diff: Diff, node: TreeNode, sign: '+' | '-' | '~'): void {
  const category = CATEGORY[node.kind];
  if (category === undefined || category === 'end') return;
  const key = `${category}${sign}`;
  diff.counts[key] = (diff.counts[key] ?? 0) + 1;
}

/** Whether a node ends its list early: a return or a throw with nodes after it. */
function early(list: readonly TreeNode[], index: number): boolean {
  const node = list[index] as TreeNode;
  return (node.kind === 'return' || node.kind === 'throw' || (node.kind === 'if' && node.form === 'guard')) && list.slice(index + 1).some((next) => next.kind !== 'end');
}

function diffLists(
  before: readonly TreeNode[],
  after: readonly TreeNode[],
  parent: string,
  branch: string | undefined,
  own: { before: ReadonlyMap<TreeNode, string>; after: ReadonlyMap<TreeNode, string> },
  diff: Diff,
): void {
  const exact = matchInOrder(before, after, (x, y) => identity(x, own.before) === identity(y, own.after));
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...exact, [before.length, after.length] as [number, number]]) {
    // Between two matches, the nodes left over of one kind are the same node changed.
    const left = before.slice(i, pi).map((node, index) => ({ node, index: i + index }));
    const right = after.slice(j, pj).map((node, index) => ({ node, index: j + index }));
    for (const [li, rj] of matchInOrder(left, right, (x, y) => x.node.kind === y.node.kind)) pairs.push([(left[li] as { index: number }).index, (right[rj] as { index: number }).index]);
    if (pi < before.length) pairs.push([pi, pj]);
    i = pi + 1;
    j = pj + 1;
  }
  pairs.sort((x, y) => x[1] - y[1]);
  const matchedBefore = new Set(pairs.map(([x]) => x));
  const matchedAfter = new Map(pairs.map(([x, y]) => [y, x]));
  after.forEach((node, index) => {
    const from = matchedAfter.get(index);
    if (from === undefined) {
      diff.marks[node.id] = 'added';
      count(diff, node, '+');
      diff.summary.push(`${nodeWords(node)}を足した${early(after, index) ? '（早期リターン）' : ''}`);
      return;
    }
    const was = before[from] as TreeNode;
    const ownBefore = own.before.get(was) ?? was.code;
    const ownAfter = own.after.get(node) ?? node.code;
    if (ownBefore !== ownAfter) {
      diff.marks[node.id] = 'modified';
      count(diff, node, '~');
      const changes = identity(was, own.before) === identity(node, own.after) || was.kind !== 'call' ? expressionChanges(ownBefore, ownAfter) : [{ text: `${nodeWords(was)}を ${nodeWords(node)}に置き換えた`, before: was.code, after: node.code }];
      if (changes.length > 0) {
        diff.exprs[node.id] = changes;
        diff.summary.push(...changes.map((change) => (change.text.includes('置き換えた') && was.kind === 'call' ? change.text : `${nodeWords(node)}: ${change.text}`)));
      }
    }
    diffLists(was.pre ?? [], node.pre ?? [], node.id, 'pre', own, diff);
    const keys = new Set([...(was.branches ?? []).map((side) => side.key), ...(node.branches ?? []).map((side) => side.key)]);
    for (const key of keys) {
      diffLists(was.branches?.find((side) => side.key === key)?.nodes ?? [], node.branches?.find((side) => side.key === key)?.nodes ?? [], node.id, key, own, diff);
    }
  });
  const partner = new Map(pairs.map(([x, y]) => [x, y]));
  before.forEach((node, index) => {
    if (matchedBefore.has(index)) return;
    const entry: RemovedNode = { parent, node };
    // Behind the node of the tree after that the nearest matched node before it became.
    for (let back = index - 1; back >= 0; back -= 1) {
      const at = partner.get(back);
      if (at === undefined) continue;
      entry.after = (after[at] as TreeNode).id;
      break;
    }
    if (branch !== undefined) entry.branch = branch;
    diff.removed.push(entry);
    count(diff, node, '-');
    diff.summary.push(`${nodeWords(node)}を消した`);
  });
}

/** The diff of two trees of a frame (see the module comment). */
export function diffTrees(
  before: FlowTree,
  after: FlowTree,
  own: { before: ReadonlyMap<TreeNode, string>; after: ReadonlyMap<TreeNode, string> },
  head: { signature: boolean; docs: boolean },
): Diff {
  const diff: Diff = { marks: {}, removed: [], exprs: {}, summary: [], counts: {} };
  if (head.signature) {
    diff.marks[''] = 'modified';
    diff.counts['signature~'] = 1;
    diff.summary.push(before.signature === after.signature ? '宣言（引数か戻り値の型）を変えた' : `宣言を \`${before.signature}\` から \`${after.signature}\` に変えた`);
  }
  diffLists(before.nodes, after.nodes, '', undefined, own, diff);
  if (head.docs) diff.summary.push('JSDoc を変えた');
  return diff;
}

/** The counts of a diff in words: `条件 +1、呼び出し +2`. */
export function countWords(counts: Readonly<Record<string, number>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(counts)) {
    const sign = key.slice(-1);
    const category = key.slice(0, -1);
    const words = category === 'signature' ? '宣言' : (CATEGORY_WORDS[category] ?? category);
    parts.push(`${words} ${sign === '~' ? '変更' : sign}${value}`);
  }
  return parts.join('、');
}

// ---- hunks on nodes

/** Every node of a tree, depth first. */
function* all(nodes: readonly TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    if (node.pre !== undefined) yield* all(node.pre);
    for (const branch of node.branches ?? []) yield* all(branch.nodes);
  }
}

/**
 * The node each hunk goes on: the smallest node whose lines hold the lines
 * the hunk changes in the head (for a hunk that only removes, the line it
 * removes before), a marked node first among nodes with the same lines; ''
 * (the start) for a hunk in the JSDoc or the declaration, or one no single
 * node holds.
 */
export function placeHunks(tree: FlowTree, hunks: readonly DiffHunk[], marks: FrameChange['marks']): Record<string, DiffHunk[]> {
  const placed: Record<string, DiffHunk[]> = {};
  const nodes = [...all(tree.nodes)];
  for (const hunk of hunks) {
    let head = hunk.head;
    const touched: number[] = [];
    for (const line of hunk.lines) {
      if (line[0] === '+') touched.push(head);
      if (line[0] === '-') touched.push(head);
      if (line[0] !== '-') head += 1;
    }
    const first = Math.min(...touched);
    const last = Math.max(...touched);
    let best: TreeNode | undefined;
    if (first > tree.head[1]) {
      for (const node of nodes) {
        if (node.lines[0] > first || node.lines[1] < last) continue;
        const span = node.lines[1] - node.lines[0];
        const bestSpan = best === undefined ? Infinity : best.lines[1] - best.lines[0];
        if (span < bestSpan || (span === bestSpan && marks[node.id] !== undefined && marks[best?.id ?? ''] === undefined)) best = node;
      }
    }
    const key = best?.id ?? '';
    (placed[key] ??= []).push(hunk);
  }
  return placed;
}
