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
 * - Code is compared by its tokens (comments, line breaks and the commas
 *   and semicolons a formatter adds are no change). A modified node's code
 *   is compared token by token: one token changed is "`<` を `<=` に変えた",
 *   an argument more or less is "引数 `issuedAt` を足した", code added or
 *   removed whole is shown as the code it is ("`.trim()` を足した"), anything
 *   larger is "式を書き換えた" with the code before and after. A change made at
 *   several places is said once, with how many.
 * - Each run of changed lines of the text diff goes on the smallest node
 *   whose lines hold it, with the lines around it that node holds; the
 *   JSDoc and the declaration on the start (''). The lines of the nodes
 *   cover the body, so every run has one.
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

/** The operators of code a token can be, the longest first. */
const OPERATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];

/** The tokens of code with where each starts and ends in it (see tokens). */
export function tokenSpans(code: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
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
      out.push({ text: code.slice(index, end + 1), start: index, end: Math.min(end + 1, code.length) });
      index = end + 1;
      continue;
    }
    const word = /^[\p{L}\p{N}_$]+/u.exec(code.slice(index));
    const text = word?.[0] ?? OPERATORS.find((candidate) => code.startsWith(candidate, index)) ?? char;
    out.push({ text, start: index, end: index + text.length });
    index += text.length;
  }
  return out;
}

/** The tokens of code: words, numbers, strings, and operators (the longest first). */
export function tokens(code: string): string[] {
  return tokenSpans(code).map((token) => token.text);
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
  const callee = code.slice(0, open).trim();
  // `if (…)`, `switch (…)`, a loop header: not a call.
  if (callee === '' || /^(if|switch|while|for|catch|return|throw)$/.test(callee)) return undefined;
  return { callee, args: splitTopLevel(code.slice(open + 1, -1)).map((arg) => arg.trim()) };
}

/** The call a statement makes as its value (`const x = await f(a)` → `f(a)`). */
function callIn(code: string): string {
  return code.replace(/^(?:export\s+)?(?:const|let|var)\s+[^=]+=\s*/, '').replace(/^(?:return|throw)\s+/, '').replace(/^await\s+/, '').replace(/;$/, '').trim();
}

/** The changes inside the code of a node: what was replaced, added and removed (see the module comment). */
export function expressionChanges(before: string, after: string): ExprChange[] {
  return collapseChanges(rawExpressionChanges(before, after));
}

/** The changes inside the code of a node, each place on its own (expressionChanges). */
function rawExpressionChanges(before: string, after: string): ExprChange[] {
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

/** How much a list of tokens opens brackets more than it closes them. */
function depthOf(list: ReadonlyArray<{ text: string }>): number {
  let depth = 0;
  for (const { text } of list) {
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
  }
  return depth;
}

/**
 * The changes between two pieces of code, token by token: the runs of tokens
 * between the matched ones, each shown as the code it is (a slice of the
 * code, not tokens joined). A run that opens a bracket the next one closes
 * (`.trim(` and `)` of `get(token)` → `get(token.trim())`) is joined with
 * it and with the matched tokens between, and the tokens both sides then
 * share at the start and the end are left out again (`.trim()`).
 */
function tokenChanges(before: string, after: string): ExprChange[] {
  const a = tokenSpans(before);
  const b = tokenSpans(after);
  const pairs = matchInOrder(a, b, (x, y) => x.text === y.text);
  // The runs of tokens between the matches, as ranges of indexes [from, to).
  type Run = { a: [number, number]; b: [number, number] };
  const runs: Run[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) runs.push({ a: [i, pi], b: [j, pj] });
    i = pi + 1;
    j = pj + 1;
  }
  const merged: Run[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    let run = runs[index] as Run;
    const balanced = (candidate: Run) => depthOf(a.slice(...candidate.a)) === 0 && depthOf(b.slice(...candidate.b)) === 0;
    let end = index;
    while (!balanced(run) && end + 1 < runs.length) {
      end += 1;
      const next = runs[end] as Run;
      run = { a: [run.a[0], next.a[1]], b: [run.b[0], next.b[1]] };
      // The tokens both sides share at the start and at the end are no change.
      const trimmed = { a: [...run.a] as [number, number], b: [...run.b] as [number, number] };
      while (trimmed.a[0] < trimmed.a[1] && trimmed.b[0] < trimmed.b[1] && a[trimmed.a[0]]?.text === b[trimmed.b[0]]?.text) {
        trimmed.a[0] += 1;
        trimmed.b[0] += 1;
      }
      while (trimmed.a[1] > trimmed.a[0] && trimmed.b[1] > trimmed.b[0] && a[trimmed.a[1] - 1]?.text === b[trimmed.b[1] - 1]?.text) {
        trimmed.a[1] -= 1;
        trimmed.b[1] -= 1;
      }
      if (balanced(trimmed)) {
        run = trimmed;
        break;
      }
    }
    if (balanced(run)) index = end;
    else run = runs[index] as Run;
    merged.push(run);
  }
  // Code added or removed whole reads as such up to a length; code replaced, while it is a small part.
  const size = (run: Run) => Math.max(run.a[1] - run.a[0], run.b[1] - run.b[0]);
  const replaced = merged.filter((run) => run.a[1] > run.a[0] && run.b[1] > run.b[0]).reduce((count, run) => count + size(run), 0);
  const whole = merged.filter((run) => run.a[1] === run.a[0] || run.b[1] === run.b[0]);
  if (merged.length > 3 || replaced > Math.max(4, Math.min(a.length, b.length) / 2) || whole.some((run) => size(run) > 30)) {
    return [{ text: '式を書き換えた', before: shorten(before, 120), after: shorten(after, 120) }];
  }
  const slice = (code: string, spans: typeof a, [from, to]: [number, number]) => (from >= to ? '' : code.slice((spans[from] as (typeof a)[number]).start, (spans[to - 1] as (typeof a)[number]).end));
  return merged.map((run) => {
    const was = slice(before, a, run.a);
    const now = slice(after, b, run.b);
    if (was === '') return { text: `\`${shorten(now, 40)}\` を足した`, after: now };
    if (now === '') return { text: `\`${shorten(was, 40)}\` を消した`, before: was };
    return { text: `\`${shorten(was, 40)}\` を \`${shorten(now, 40)}\` に変えた`, before: was, after: now };
  });
}

/** Phrases with the repeats of each said once, with how many times (`… を変えた（2 箇所）`), in the order of their first time. */
export function collapse(phrases: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const phrase of phrases) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  return [...counts].map(([phrase, count]) => (count > 1 ? `${phrase}（${count} 箇所）` : phrase));
}

// ---- trees

/**
 * Code as the diff compares it: its tokens, without the commas before a
 * closing bracket and the semicolons before a closing brace or at the end,
 * so a formatter that breaks lines, adds trailing commas or semicolons
 * changes nothing.
 */
export function normalCode(code: string): string {
  const list = tokens(code);
  return list.filter((token, index) => !((token === ',' && [')', ']', '}'].includes(list[index + 1] ?? '')) || (token === ';' && (list[index + 1] ?? '}') === '}'))).join(' ');
}

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
      return `${node.kind}:${normalCode(own.get(node) ?? node.code)}`;
  }
}

interface Diff {
  marks: FrameChange['marks'];
  removed: RemovedNode[];
  exprs: FrameChange['exprs'];
  summary: string[];
  counts: Record<string, number>;
}

/** How a diff names the nodes of the tree after in its summary: nodeWords, unless `describe` names one (the member a part of an object literal implements). */
interface Naming {
  describe?: (node: TreeNode) => string | undefined;
}

/** The name of a node in a summary: `\`verifyClientSecret()\` の呼び出し`, `条件 \`!client\``. */
export function nodeWords(node: TreeNode): string {
  switch (node.kind) {
    case 'call':
      return `\`${node.code.replace(/^.*?=\s*(?:await\s+)?/, '').replace(/\(.*$/, '')}()\` の呼び出し`;
    case 'if':
    case 'cond-expr':
      return `条件 \`${shorten(node.subject ?? node.code, 70)}\``;
    case 'switch':
      return `分岐 \`${shorten(node.subject ?? node.code, 70)}\``;
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

/**
 * The counts of the nodes a diff marks among some nodes (see Diff.counts:
 * `call+`, `action~`, ...): what a part of a frame changed, the
 * implementation of a member for one. The nodes it removed have no place
 * in the tree after and are left out.
 */
export function markCounts(nodes: Iterable<TreeNode>, marks: FrameChange['marks']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    const mark = marks[node.id];
    const category = CATEGORY[node.kind];
    if (mark === undefined || category === undefined || category === 'end') continue;
    const key = `${category}${mark === 'added' ? '+' : '~'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
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

/** How an added node leaves its list early, in words: by a throw (a guard whose side throws included) or by a return. */
function earlyWords(node: TreeNode): string {
  const exit = node.kind === 'if' ? [...(node.branches?.find((branch) => branch.key === 'true')?.nodes ?? [])].reverse().find((child) => child.kind === 'return' || child.kind === 'throw') : node;
  return exit?.kind === 'throw' ? '（失敗で抜ける）' : '（早期リターン）';
}

/** The changes of a node with the repeats of each said once (collapse). */
function collapseChanges(changes: readonly ExprChange[]): ExprChange[] {
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.text, (counts.get(change.text) ?? 0) + 1);
  const seen = new Set<string>();
  return changes.flatMap((change) => {
    if (seen.has(change.text)) return [];
    seen.add(change.text);
    const times = counts.get(change.text) ?? 1;
    return [times > 1 ? { ...change, text: `${change.text}（${times} 箇所）` } : change];
  });
}

function diffLists(
  before: readonly TreeNode[],
  after: readonly TreeNode[],
  parent: string,
  branch: string | undefined,
  own: { before: ReadonlyMap<TreeNode, string>; after: ReadonlyMap<TreeNode, string> },
  diff: Diff,
  naming: Naming,
): void {
  const named = (node: TreeNode) => naming.describe?.(node) ?? nodeWords(node);
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
      diff.summary.push(`${named(node)} を足した${early(after, index) ? earlyWords(node) : ''}`);
      return;
    }
    const was = before[from] as TreeNode;
    const ownBefore = own.before.get(was) ?? was.code;
    const ownAfter = own.after.get(node) ?? node.code;
    if (normalCode(ownBefore) !== normalCode(ownAfter)) {
      diff.marks[node.id] = 'modified';
      count(diff, node, '~');
      const changes = collapseChanges(identity(was, own.before) === identity(node, own.after) || was.kind !== 'call' ? expressionChanges(ownBefore, ownAfter) : [{ text: `${nodeWords(was)} を ${nodeWords(node)} に置き換えた`, before: was.code, after: node.code }]);
      if (changes.length > 0) {
        diff.exprs[node.id] = changes;
        diff.summary.push(...changes.map((change) => (change.text.includes('置き換えた') && was.kind === 'call' ? change.text : `${named(node)}: ${change.text}`)));
      }
    }
    diffLists(was.pre ?? [], node.pre ?? [], node.id, 'pre', own, diff, naming);
    const keys = new Set([...(was.branches ?? []).map((side) => side.key), ...(node.branches ?? []).map((side) => side.key)]);
    for (const key of keys) {
      diffLists(was.branches?.find((side) => side.key === key)?.nodes ?? [], node.branches?.find((side) => side.key === key)?.nodes ?? [], node.id, key, own, diff, naming);
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
    diff.summary.push(`${nodeWords(node)} を消した`);
  });
}

/**
 * The diff of two trees of a frame (see the module comment); `describe`
 * names a node of the tree after in the summary instead of nodeWords. A
 * phrase said more than once is said once, with how many times.
 */
export function diffTrees(
  before: FlowTree,
  after: FlowTree,
  own: { before: ReadonlyMap<TreeNode, string>; after: ReadonlyMap<TreeNode, string> },
  head: { signature: boolean; docs: boolean },
  naming: Naming = {},
): Diff {
  const diff: Diff = { marks: {}, removed: [], exprs: {}, summary: [], counts: {} };
  if (head.signature) {
    diff.marks[''] = 'modified';
    diff.counts['signature~'] = 1;
    diff.summary.push(before.signature === after.signature ? '宣言（引数か戻り値の型）を変えた' : `宣言を \`${before.signature}\` から \`${after.signature}\` に変えた`);
  }
  diffLists(before.nodes, after.nodes, '', undefined, own, diff, naming);
  if (head.docs) diff.summary.push('JSDoc を変えた');
  diff.summary = collapse(diff.summary);
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

/** The lines of context a piece of a hunk keeps on each side of its changes. */
const HUNK_CONTEXT = 3;

/** A line of a hunk with where it is: the lines of the base and of the head before it, and the line of the head it stands at. */
interface HunkLine {
  text: string;
  op: string;
  base: number;
  head: number;
  /** The line of the head it is at: its own for a kept or added line; for a removed line, that of the added line it became, else where it was removed. */
  at: number;
}

/** How alike two lines of code are: the share of their tokens they have in common (0 to 1). */
function likeness(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.length + right.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of right) {
    const count = counts.get(token) ?? 0;
    if (count === 0) continue;
    counts.set(token, count - 1);
    common += 1;
  }
  return (2 * common) / (left.length + right.length);
}

/**
 * Where the removed lines of a run of changed lines stand in the head: each
 * at the added line it became (as many removed as added: in order; else
 * the alike ones, in order), the others at the added line after the one
 * the removed line before became, and with nothing added, where they were
 * removed.
 */
function placeRemoved(run: readonly HunkLine[]): void {
  const removed = run.filter((line) => line.op === '-');
  const added = run.filter((line) => line.op === '+');
  if (removed.length === 0 || added.length === 0) return;
  const pairs = removed.length === added.length ? removed.map((_line, index) => [index, index] as [number, number]) : matchInOrder(removed, added, (x, y) => likeness(x.text.slice(1), y.text.slice(1)) >= 0.5);
  const partner = new Map(pairs);
  let next = 0;
  removed.forEach((line, index) => {
    const paired = partner.get(index);
    if (paired !== undefined) {
      line.at = (added[paired] as HunkLine).head;
      next = paired + 1;
      return;
    }
    line.at = (added[Math.min(next, added.length - 1)] as HunkLine).head;
  });
}

/**
 * The hunks by node (FrameChange.hunks). Each run of changed lines of a hunk
 * goes to the smallest node whose lines hold it, with the kept lines around
 * it (up to three on each side) that the node holds too: a node of a list
 * or a marked node, so a run on the line of an `if` goes to the `if`, not to
 * the call its condition makes. The lines of the JSDoc and the declaration
 * go to '' (the start). A run that no node holds whole is cut where the
 * nodes of the body meet, each piece (its removed lines with the added lines
 * they became) on the node that holds it. Two runs on the same node in one
 * hunk stay one hunk.
 */
export function placeHunks(tree: FlowTree, hunks: readonly DiffHunk[], marks: FrameChange['marks']): Record<string, DiffHunk[]> {
  const placed: Record<string, DiffHunk[]> = {};
  const candidates: TreeNode[] = [];
  const visit = (nodes: readonly TreeNode[], evaluated: boolean) => {
    for (const node of nodes) {
      if (!evaluated || marks[node.id] !== undefined) candidates.push(node);
      if (node.pre !== undefined) visit(node.pre, true);
      for (const branch of node.branches ?? []) visit(branch.nodes, false);
    }
  };
  visit(tree.nodes, false);
  const span = (node: TreeNode) => node.lines[1] - node.lines[0];
  /** The node that holds lines: the smallest, a marked one first among those of one size, the outer first among the rest. */
  const holder = (first: number, last: number): TreeNode | undefined => {
    let best: TreeNode | undefined;
    for (const node of candidates) {
      if (node.lines[0] > first || node.lines[1] < last) continue;
      if (best === undefined || span(node) < span(best) || (span(node) === span(best) && marks[node.id] !== undefined && marks[best.id] === undefined)) best = node;
    }
    return best;
  };
  const start: [number, number] = [tree.lines[0], tree.head[1]];
  const topOf = (line: number) => tree.nodes.find((node) => line >= node.lines[0] && line <= node.lines[1]) ?? tree.nodes[tree.nodes.length - 1];
  for (const hunk of hunks) {
    // Where each line is.
    const lines: HunkLine[] = [];
    let base = hunk.base;
    let head = hunk.head;
    for (const text of hunk.lines) {
      const op = text[0] ?? ' ';
      lines.push({ text, op, base, head, at: head });
      if (op !== '+') base += 1;
      if (op !== '-') head += 1;
    }
    // The pieces of the runs of changed lines, in order: the node, the lines (indexes), and the first and the last index of the run.
    type Piece = { key: string; lines: [number, number]; indexes: number[]; from: number; to: number };
    const pieces: Piece[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if ((lines[index] as HunkLine).op === ' ') continue;
      let end = index;
      while (end + 1 < lines.length && (lines[end + 1] as HunkLine).op !== ' ') end += 1;
      const run = lines.slice(index, end + 1);
      placeRemoved(run);
      // A run that only removes lines past the last node of the body stands on the line before.
      if (!run.some((line) => line.op === '+')) {
        const at = (run[0] as HunkLine).at;
        if (at > tree.head[1] && !candidates.some((node) => node.lines[0] <= at && node.lines[1] >= at)) for (const line of run) line.at = at - 1;
      }
      const indexes = run.map((_line, offset) => index + offset);
      // Removed lines first, then added ones, in each piece.
      const ordered = (list: readonly number[]) => [...list.filter((at) => (lines[at] as HunkLine).op === '-'), ...list.filter((at) => (lines[at] as HunkLine).op === '+')];
      const add = (key: string, range: [number, number], list: readonly number[]) => {
        if (list.length > 0) pieces.push({ key, lines: range, indexes: ordered(list), from: index, to: end });
      };
      add('', start, indexes.filter((at) => (lines[at] as HunkLine).at <= tree.head[1]));
      const body = indexes.filter((at) => (lines[at] as HunkLine).at > tree.head[1]);
      const ats = body.map((at) => (lines[at] as HunkLine).at);
      const whole = body.length === 0 ? undefined : holder(Math.min(...ats), Math.max(...ats));
      if (whole !== undefined) add(whole.id, whole.lines, body);
      else {
        // Cut where the nodes of the body meet.
        const tops = new Map<TreeNode | undefined, number[]>();
        for (const at of body) tops.set(topOf((lines[at] as HunkLine).at), [...(tops.get(topOf((lines[at] as HunkLine).at)) ?? []), at]);
        for (const [top, list] of tops) {
          const part = list.map((at) => (lines[at] as HunkLine).at);
          const node = holder(Math.min(...part), Math.max(...part)) ?? top;
          if (node === undefined) add('', start, list);
          else add(node.id, node.lines, list);
        }
      }
      index = end;
    }
    // Two pieces of one node from runs one after the other are one piece, with the kept lines between.
    const merged: Piece[] = [];
    for (const piece of pieces) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.key === piece.key && last.to < piece.from) {
        last.indexes = [...last.indexes, ...Array.from({ length: piece.from - last.to - 1 }, (_value, offset) => last.to + 1 + offset), ...piece.indexes];
        last.to = piece.to;
      } else merged.push({ ...piece, indexes: [...piece.indexes] });
    }
    for (const piece of merged) {
      const holds = (line: HunkLine | undefined) => line !== undefined && line.op === ' ' && line.head >= piece.lines[0] && line.head <= piece.lines[1];
      const before: number[] = [];
      for (let at = piece.from - 1; at >= 0 && before.length < HUNK_CONTEXT && holds(lines[at]); at -= 1) before.unshift(at);
      const after: number[] = [];
      for (let at = piece.to + 1; at < lines.length && after.length < HUNK_CONTEXT && holds(lines[at]); at += 1) after.push(at);
      const chosen = [...before, ...piece.indexes, ...after].map((at) => lines[at] as HunkLine);
      const first = chosen[0] as HunkLine;
      const baseLine = chosen.find((line) => line.op !== '+')?.base ?? first.base;
      const headLine = chosen.find((line) => line.op !== '-')?.head ?? first.head;
      (placed[piece.key] ??= []).push({ base: baseLine, head: headLine, lines: chosen.map((line) => line.text) });
    }
  }
  return placed;
}
