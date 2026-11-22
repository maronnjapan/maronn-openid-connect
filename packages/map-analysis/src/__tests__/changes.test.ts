import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changesMarkdown, changeTargets, diffLines, hunksOf, LARGE_PULL_REQUEST, LINKS_PLACE, memberCounts, parseNameStatus, pullRequestOf, targetLabels, touchedLines } from '../changes.js';
import type { FlowTree, FrameChangeEntry, MapChanges, TreeNode } from '../model.js';

describe('parseNameStatus', () => {
  it('should read added, modified, deleted and renamed files with their paths before and after', () => {
    const output = ['A', 'new.ts', 'M', 'same.ts', 'D', 'gone.ts', 'R087', 'old.ts', 'renamed.ts', 'C100', 'from.ts', 'copy.ts', ''].join('\0');
    expect(parseNameStatus(output)).toEqual([
      { status: 'A', after: 'new.ts' },
      { status: 'M', before: 'same.ts', after: 'same.ts' },
      { status: 'D', before: 'gone.ts' },
      { status: 'R', before: 'old.ts', after: 'renamed.ts' },
      { status: 'A', after: 'copy.ts' },
    ]);
  });
});

describe('diffLines and hunksOf', () => {
  it('should keep the common lines, and write the changes in hunks with the lines around them', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const b = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const ops = diffLines(a, b);
    expect(ops.filter((op) => op.op !== ' ')).toEqual([{ op: '-', a: 2 }, { op: '+', b: 2 }, { op: '+', b: 9 }]);
    const { hunks, added } = hunksOf(ops, a, b, 10, 20, 1);
    expect(added).toEqual([22, 29]);
    expect(hunks).toEqual([
      { base: 11, head: 21, lines: [' b', '-c', '+C', ' d'] },
      { base: 18, head: 28, lines: [' i', '+j'] },
    ]);
  });
});

describe('touchedLines', () => {
  it('should give the lines of the head the diff adds, and the line before which it removes one', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'e', 'd']);
    expect(touchedLines(ops, 10)).toEqual([11, 11, 13]);
    expect(touchedLines(diffLines(['a', 'b', 'c'], ['a', 'c']), 1)).toEqual([2]);
  });
});

describe('changeTargets', () => {
  const node = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'action', lines: [1, 1], code: id, ...extra });
  const tree: FlowTree = {
    id: 'f',
    name: 'f',
    signature: 'f()',
    file: 'x',
    lines: [1, 9],
    head: [1, 1],
    nodes: [node('s0'), node('s1', { kind: 'if', branches: [{ key: 'true', label: '成立', nodes: [node('s1t0')] }, { key: 'false', label: '不成立', nodes: [node('s1e0')] }] }), node('s2')],
  };

  it('should give the start, each changed node outside another, and where nodes were removed', () => {
    const change = { marks: { '': 'modified' as const, s1t0: 'modified' as const, s1e0: 'added' as const }, removed: [{ after: 's0', parent: '', node: node('old') }, { parent: 's1', branch: 'true', node: node('older') }], hunks: {} };
    expect(changeTargets(tree, change)).toEqual(['', 's1t0', 's1e0', 's0', 's1']);
  });

  it('should leave out a place a changed node holds, and fall back to a node with a hunk', () => {
    const change = { marks: { s1: 'modified' as const, s1t0: 'added' as const }, removed: [{ parent: 's1', branch: 'false', node: node('old') }], hunks: {} };
    expect(changeTargets(tree, change)).toEqual(['s1']);
    expect(changeTargets(tree, { marks: {}, removed: [], hunks: { s2: [] } })).toEqual(['s2']);
  });

  it('should keep a removal at the start of the body to itself only when nothing else changed', () => {
    const removed = [{ parent: '', node: node('old') }];
    expect(changeTargets(tree, { marks: { s2: 'modified' }, removed, hunks: {} })).toEqual(['s2']);
    expect(changeTargets(tree, { marks: {}, removed, hunks: {} })).toEqual(['']);
  });

  it('should name each place by what changed there, and by its line when two read the same', () => {
    const same = { ...tree, nodes: [node('s0', { lines: [2, 2], code: 'x = a < b' }), node('s1', { lines: [5, 5], code: 'x = a < b' }), node('s2', { lines: [7, 7] })] };
    const change = {
      marks: { '': 'modified' as const, s0: 'modified' as const, s1: 'modified' as const },
      removed: [{ after: 's2', parent: '', node: node('audit()', { kind: 'call' }) }],
      exprs: { s0: [{ text: '`<` を `<=` に変えた' }], s1: [{ text: '`<` を `<=` に変えた' }] },
    };
    expect([...targetLabels(same, change, ['', 's0', 's1', 's2'])]).toEqual([
      ['', '宣言'],
      ['s0', '処理 `x = a < b`: `<` を `<=` に変えた（2 行目）'],
      ['s1', '処理 `x = a < b`: `<` を `<=` に変えた（5 行目）'],
      ['s2', '`audit()` の呼び出し を消した'],
    ]);
  });

  it('should name a change of the start by what the summary says of the declaration', () => {
    const change = { marks: { '': 'modified' as const }, removed: [], exprs: {}, summary: ['宣言を `f(a)` から `f(a, b)` に変えた', '条件 `b` を足した'] };
    expect([...targetLabels(tree, change, [''])]).toEqual([['', '宣言を `f(a)` から `f(a, b)` に変えた']]);
  });
});

describe('memberCounts', () => {
  const node = (id: string, lines: [number, number], extra: Partial<TreeNode> = {}): TreeNode => ({ id, kind: 'action', lines, code: id, ...extra });
  // Two stores in a row, each an object literal of methods: consume and get in the first, set in the second.
  const tree: FlowTree = {
    id: 'stores',
    name: 'createStores',
    signature: 'createStores()',
    file: 'x',
    lines: [1, 30],
    head: [1, 1],
    nodes: [node('s0', [2, 12]), node('s1', [13, 20]), node('s2', [21, 29], { kind: 'return' })],
    implements: [
      { member: 'Store.consume', lines: [3, 6] },
      { member: 'Store.get', lines: [7, 11] },
      { member: 'Other.set', lines: [14, 19] },
    ],
  };

  it('should count for each member only the changes in its own lines', () => {
    const marks = { s0: 'modified' as const, s1: 'modified' as const };
    const implementations = tree.implements ?? [];
    expect(memberCounts(tree, marks, implementations.slice(0, 1), [4])).toEqual({ 'Store.consume': { 'action~': 1 } });
    expect(memberCounts(tree, marks, implementations, [4, 15])).toEqual({ 'Store.consume': { 'action~': 1 }, 'Store.get': {}, 'Other.set': { 'action~': 1 } });
  });

  it('should count a node that holds two changed lines of a member once', () => {
    expect(memberCounts(tree, { s0: 'modified' }, (tree.implements ?? []).slice(0, 1), [3, 5])).toEqual({ 'Store.consume': { 'action~': 1 } });
  });
});

describe('pullRequestOf', () => {
  it('should read the pull request from the environment, and nothing without a number', () => {
    expect(pullRequestOf({ MAP_PR: '12', MAP_PR_TITLE: 't', MAP_PR_URL: 'u' })).toEqual({ number: 12, title: 't', url: 'u' });
    expect(pullRequestOf({})).toBeUndefined();
  });
});

describe('changesMarkdown', () => {
  const frame = (extra: Partial<FrameChangeEntry>): FrameChangeEntry => ({ id: 'core:a.ts#f', name: 'f', package: 'core', module: 'a.ts', line: 3, kind: 'modified', summary: ['条件 `x` を足した'], counts: { 'condition+': 1 }, reach: [], documented: false, required: false, ...extra });
  const changes = (frames: FrameChangeEntry[]): MapChanges => ({
    base: { ref: 'origin/main', commit: 'abc' },
    head: { commit: 'def', dirty: false },
    notes: [],
    frames,
    unmatched: [],
    unknown: [],
    ambiguous: [],
    undocumented: frames.filter((entry) => entry.required && !entry.documented).map((entry) => entry.id),
    outside: [],
    otherFiles: 0,
  });
  const way = { source: 'hono', frameworks: ['hono', 'express', 'fastify'], endpoint: 'token', frames: [], decisions: {}, via: [], features: [], target: 's0' };

  it('should list first the changes that need an explanation and have none, with a draft of the sections the check needs', () => {
    const markdown = changesMarkdown(
      changes([
        frame({ required: true, reach: [way] }),
        frame({ id: 'endpoint:token', name: 'token', body: true, module: 'oidc-provider/endpoints/token/pipeline.ts', required: true }),
        frame({ id: 'core:b.ts#g', name: 'g', module: 'b.ts' }),
      ]),
    );
    expect(markdown.startsWith('### 説明の無い変更（2）\n')).toBe(true);
    expect(markdown).toContain('| `f()` | core a.ts:3 | 条件 `x` を足した（条件 +1） | token |');
    expect(markdown).toContain('| `token`（エンドポイントの処理） | core oidc-provider/endpoints/token/pipeline.ts:3 | 条件 `x` を足した（条件 +1） | （エンドポイントそのもの） |');
    expect(markdown).toContain('## f <!-- core:a.ts#f -->');
    expect(markdown).toContain('- 説明の無い変更 2');
    // A change that needs no note is in the folded table only.
    expect(markdown.slice(0, markdown.indexOf('**確かめること**'))).not.toContain('`g()`');
    expect(markdown).toContain('| 変更 | `g()` | core b.ts:3 | 条件 `x` を足した（条件 +1） | なし | 説明なし |');
  });

  it('should put a line a note, what to check and the place of the links outside the folds, and the changed frames in one', () => {
    const markdown = changesMarkdown({
      ...changes([frame({ documented: true, noteLine: '短い秘密を拒む。' }), frame({ id: 'core:b.ts#g', name: 'g', module: 'b.ts', kind: 'added' })]),
      notes: [{ file: 'apps/map/changes/dpop.md', title: 'DPoP を足す', summary: `${'あ'.repeat(320)}\n\n二段落目` }],
      untested: [],
      addedLines: { comment: 1889, code: 2171 },
      outside: [{ file: 'core:a.ts', lines: [1, 2] }],
    });
    expect(markdown.split('\n').slice(0, 7)).toEqual([`**DPoP を足す** — ${'あ'.repeat(299)}…`, '', '**確かめること**', '- 説明の無い変更 0 · テストを変えていない変更 0', '- コメント +1,889 行、コード +2,171 行（コードが 400 行を超えています。目的ごとに PR を分けられないか見直してください）', '', LINKS_PLACE]);
    expect(markdown).toContain('\n<details><summary>変わった関数 2（追加 1 · 変更 1）</summary>\n\n| 札 | 関数 | 場所 | 自動要約 | 届くエンドポイント | メモ |\n');
    expect(markdown).toContain('\n関数の外（import、型、定数など）の変更: 1 ファイル、2 行（地図の「このPRの変更」にあります）\n\n</details>\n');
    expect(markdown).not.toContain('二段落目');
  });

  it('should not ask to split a pull request whose code stays within the limit', () => {
    const markdown = changesMarkdown({ ...changes([]), addedLines: { comment: 12, code: LARGE_PULL_REQUEST } });
    expect(markdown).toContain(`\n- コメント +12 行、コード +${LARGE_PULL_REQUEST} 行\n`);
  });

  it('should leave the place of the links by the line the comment of the pull request replaces', () => {
    const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../.github/scripts/map-comment.mjs'), 'utf8');
    expect(script).toContain(`export const LINKS_PLACE = '${LINKS_PLACE}';`);
  });

  it('should put the sections of an extension that fail the check after the changes without a note, before the notes', () => {
    const markdown = changesMarkdown(changes([frame({ required: true })]), { failing: ['### 関連するテストに変更の無い実装の変更（1、CI を落とす）\n\n- `f()`\n', ''] });
    const order = ['### 説明の無い変更（1）', '### 関連するテストに変更の無い実装の変更（1、CI を落とす）', '変更メモ（`apps/map/changes/*.md`）がありません。', '**確かめること**', LINKS_PLACE, '<details><summary>変わった関数'].map((text) => markdown.indexOf(text));
    expect(order.every((index, position) => index !== -1 && (position === 0 || index > (order[position - 1] as number)))).toBe(true);
  });

  it('should show the failures a change makes leave its frame, where they are caught, and the features its endpoints need', () => {
    const caught = { ...way, features: ['refresh-token'], caught: { frame: 'endpoint:token', name: 'POST /token', node: 's0', call: 'respondTokenError(…)' } };
    const escapes = { ...way, source: 'nextjs', frameworks: ['nextjs'], escapes: true as const };
    const markdown = changesMarkdown(changes([frame({ documented: true, noteLine: '短い秘密を拒む。', failuresAdded: ['RangeError'], failuresRemoved: ['Error'], reach: [caught, escapes] })]));
    expect(markdown).toContain('| 変更 | `f()` | core a.ts:3 | 条件 `x` を足した（条件 +1） / 外へ出る失敗 +`RangeError` −`Error` | token（機能: refresh-token）, token (nextjs) | 短い秘密を拒む。 |');
    expect(markdown).toContain('- `f()` から新しく外へ出る失敗 `RangeError`: catch で捕まえて `respondTokenError(…)`（token）が応答する / エンドポイントの外へ出る（token (nextjs)）');
    expect(markdown).toContain('- `f()` から外へ出なくなった失敗 `Error`');
  });

  it('should show the phrases of a summary that fit whole, with their code spans closed', () => {
    const long = `条件 \`${'a'.repeat(200)}\` を足した`;
    const markdown = changesMarkdown(changes([frame({ summary: ['宣言を変えた', long], counts: {} })]));
    expect(markdown).toContain('| 変更 | `f()` | core a.ts:3 | 宣言を変えた ほか 1 | なし | 説明なし |');
    expect(changesMarkdown(changes([frame({ summary: [long], counts: {} })]))).toContain(`| 条件 \`${'a'.repeat(175)}…\` | なし |`);
  });

  it('should end with the sections an extension of the build adds, each after a blank line', () => {
    const markdown = changesMarkdown(changes([frame({ documented: true, noteLine: '短い秘密を拒む。' })]), { sections: ['<details><summary>テスト 1 → 2</summary>\n\nテストケース: +1\n\n</details>\n', '  '] });
    expect(markdown.endsWith('\n</details>\n\n<details><summary>テスト 1 → 2</summary>\n\nテストケース: +1\n\n</details>\n')).toBe(true);
  });

  it('should say the calls the types do not tell may reach a change', () => {
    const markdown = changesMarkdown(changes([frame({ untraceableCallers: [{ frame: 'hono:a.ts#issue', node: 's11', why: "c.get('consentResolver') の recordGrant がどの型のメンバーか分からない" }] })]));
    expect(markdown).toContain('| 変更 | `f()` | core a.ts:3 | 条件 `x` を足した（条件 +1） | なし（追えない呼び出し 1 箇所） |');
    expect(markdown).toContain("- `f()`: 型で呼び先を引けない呼び出し 1 箇所が、この変更を呼んでいるかもしれません（届くエンドポイントには入れていません）: `issue`（c.get('consentResolver') の recordGrant がどの型のメンバーか分からない）");
  });

  it('should narrow an ambiguous heading by a root only when the matches are in more than one', () => {
    const roots = changesMarkdown({ ...changes([]), ambiguous: [{ file: 'n.md', reference: 'f', matches: ['core:a.ts#f', 'hono:b.ts#f'] }] });
    const ids = changesMarkdown({ ...changes([]), ambiguous: [{ file: 'n.md', reference: 'createProviderStores', matches: ['hono:db/kv/stores.ts#createProviderStores', 'hono:db/memory/stores.ts#createProviderStores'] }] });
    expect(roots).toContain('`core:f` のようにルートで絞り込むか、id を書いてください: `core:a.ts#f`, `hono:b.ts#f`');
    expect(ids).toContain('どれも `hono` にあるので、id（見出しの末尾に `<!-- id -->`）で絞り込んでください: `hono:db/kv/stores.ts#createProviderStores`, `hono:db/memory/stores.ts#createProviderStores`');
  });

  it('should show the first line of the note of an explained change, and no list of the unexplained when there is none', () => {
    const markdown = changesMarkdown(changes([frame({ documented: true, noteLine: '境界をそろえる。', required: true, reach: [way, { ...way, source: 'nextjs', frameworks: ['nextjs'] }] })]));
    expect(markdown).not.toContain('### 説明の無い変更');
    expect(markdown).toContain('- 説明の無い変更 0\n');
    expect(markdown).toContain('| 変更 | `f()` | core a.ts:3 | 条件 `x` を足した（条件 +1） | token, token (nextjs) | 境界をそろえる。 |');
  });
});
