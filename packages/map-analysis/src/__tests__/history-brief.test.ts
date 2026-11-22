import { describe, expect, it } from 'vitest';
import { changeBrief, changeNamed, entryOf, functionBrief, functionsNamed, keyOf, keyOfInput, listBrief, placeOf, unifiedHunk, type BriefMap } from '../history-brief.js';
import type { FunctionEntry, HistoryData, HistoryDetail, HistoryEntry } from '../model.js';

/** A change that reached main. */
function change(overrides: Partial<HistoryEntry>): HistoryEntry {
  return { commit: 'a'.repeat(40), date: '2026-11-21T10:00:00+09:00', kind: 'merge', title: 't', authors: ['Claude'], commits: [], files: [], functions: [], notes: [], additions: 0, deletions: 0, ...overrides };
}

/** A function of the map, its root and module read from its id. */
function fn(id: string, name: string, source?: FunctionEntry['source'], calledBy: string[] = []): FunctionEntry {
  const pkg = id.slice(0, id.indexOf(':'));
  const module = id.slice(id.indexOf(':') + 1, id.lastIndexOf('#'));
  return { id, name, package: pkg, module, line: source?.start ?? 1, calledBy, ...(source === undefined ? {} : { source }) } as unknown as FunctionEntry;
}

const READING = [
  '- 「今のコード」の行は、地図をビルドしたときのコードのもの。ビルドの後にコードを変えたら、その行はずれる',
  '- 「今これを呼ぶもの」は、関数とエンドポイントの処理から型で辿れる呼び出しだけで、登録・初期化・モジュールの最上位からの呼び出しは入らない',
];

const map: BriefMap = {
  functions: {
    'core:a.ts#verify': fn('core:a.ts#verify', 'verify', { file: 's1', start: 10, end: 24 }, ['core:b.ts#token', 'hono:token#body']),
    'core:b.ts#token': fn('core:b.ts#token', 'token', { file: 's2', start: 3, end: 9 }),
    'experimental:c.ts#verify': fn('experimental:c.ts#verify', 'verify', { file: 's3', start: 1, end: 2 }),
  },
  bodies: { 'hono:token#body': { id: 'hono:token#body', name: 'POST /token', package: 'hono', module: 'token', endpoint: 'token', source: { file: 's4', start: 5, end: 40 } } as unknown as BriefMap['bodies'][string] },
  sources: { s1: { path: 'packages/core/src/a.ts', url: '' }, s2: { path: 'packages/core/src/b.ts', url: '' }, s3: { path: 'packages/experimental/src/c.ts', url: '' }, s4: { path: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', url: '' } },
};

const merged = change({
  commit: `b${'1'.repeat(39)}`,
  pr: 209,
  title: 'クライアント認証を足す',
  branch: 'claude/auth',
  body: '<!--\n書き方の案内\n-->\n## 概要\n\n認証を足す。\n二行目。\n\n## 影響\n',
  commits: [{ sha: `c${'2'.repeat(39)}`, subject: 'verify を直す', date: '2026-11-21T09:00:00+09:00', author: 'Claude' }],
  functions: [
    { id: 'core:a.ts#verify', name: 'verify', status: 'modified' },
    { id: 'core:a.ts#gone', name: 'gone', status: 'removed' },
  ],
  notes: ['apps/map/changes/auth.md'],
  detail: './data/history/b.json',
});
const history: HistoryData = {
  version: 1,
  repository: 'owner/name',
  entries: [change({ commit: `d${'3'.repeat(39)}`, kind: 'direct', title: 'typo', date: '2026-11-22T10:00:00+09:00' }), merged, change({ commit: `e${'4'.repeat(39)}`, pr: 150, title: 'verify を足す', functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'added' }], detail: './data/history/e.json' })],
  functions: { 'core:a.ts#verify': [1, 2], 'core:a.ts#gone': [1] },
};
const detail: HistoryDetail = {
  version: 1,
  commit: merged.commit,
  notes: [{ path: 'apps/map/changes/auth.md', text: '# 認証\n\nなぜ変えたか。\n\n## verify <!-- core:a.ts#verify -->\n\n戻り値を 2 にした。\n\n## token\n\n別の関数。\n' }],
  files: [
    {
      path: 'packages/core/src/a.ts',
      status: 'modified',
      functions: [
        { id: 'core:a.ts#verify', hunks: [{ base: 10, head: 10, lines: [' export function verify() {', '-  return 1;', '+  return 2;', ' }'] }] },
        { id: 'core:a.ts#gone', hunks: [] },
      ],
      outside: [{ base: 1, head: 1, lines: ["-import { x } from './x';", "+import { x, y } from './y';"] }],
    },
    { path: 'apps/nextjs/src/app/(ciba)/big.ts', status: 'added', functions: [], outside: [], omitted: 'file' },
  ],
};

describe('the keys of the changes', () => {
  it('should read #219, 219 and pr-219 as the key of the pull request, and keep a commit as it is', () => {
    expect([keyOfInput('#219'), keyOfInput(' 219 '), keyOfInput('PR-219'), keyOfInput('pr219'), keyOfInput('B1111111')]).toEqual(['pr-219', 'pr-219', 'pr-219', 'pr-219', 'b1111111']);
  });

  it('should find a change by its pull request, by the start of its commit and by a commit of its branch', () => {
    expect([entryOf(history, 'pr-209')?.title, entryOf(history, 'd3333333')?.title, entryOf(history, 'pr-1')]).toEqual(['クライアント認証を足す', 'typo', undefined]);
    expect([changeNamed(history, '#209')?.title, changeNamed(history, 'c2222222')?.title, changeNamed(history, 'f0000000')]).toEqual(['クライアント認証を足す', 'クライアント認証を足す', undefined]);
  });

  it('should key by its commit a change whose pull request number a newer change has too, and link it to its commit', () => {
    const newer = change({ commit: `f${'5'.repeat(39)}`, pr: 19, title: 'newer' });
    const older = change({ commit: `9${'6'.repeat(39)}`, pr: 19, title: 'older', functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'modified' }] });
    const shared: HistoryData = { version: 1, repository: 'owner/name', entries: [newer, older], functions: { 'core:a.ts#verify': [1] } };
    expect([keyOf(shared, newer), keyOf(shared, older), entryOf(shared, keyOf(shared, older))?.title]).toEqual(['pr-19', '9666666666', 'older']);
    expect(listBrief(shared).split('\n').slice(2, 4)).toEqual(['- pr-19 2026-11-21 #19 newer（関数の変更なし）', '- 9666666666 2026-11-21 #19 older（関数 +0 ~1 -0）']);
    expect(changeBrief(map, shared, older, undefined).split('\n')[2]).toBe('- キー: 9666666666 · main に入った日: 2026-11-21 · 作成者: Claude · https://github.com/owner/name/commit/9666666666666666666666666666666666666666');
    expect(functionBrief(map, shared, 'core:a.ts#verify', new Map()).includes('- キー: 9666666666 · 2026-11-21 · 変更 · 作成者: Claude')).toBe(true);
  });
});

describe('a change for an AI', () => {
  it('should write the intent, each function with its diff and its place now, and how to read the rest with git', () => {
    expect(changeBrief(map, history, merged, detail).split('\n')).toEqual([
      '# PR #209: クライアント認証を足す',
      '',
      '- キー: pr-209 · main に入った日: 2026-11-21 · ブランチ: claude/auth · 作成者: Claude · https://github.com/owner/name/pull/209',
      '- 差分は、OSS が出すコード（関数カタログの根のファイル）の、変更したときのもの。判断の前に、各関数の「今のコード」の行を読む',
      '- テストや文書を含む変更全体: `git show --diff-merges=first-parent --format= b11111111111`',
      ...READING,
      '',
      '## 意図',
      '',
      '### PR の本文',
      '',
      '```markdown',
      '<!--',
      '書き方の案内',
      '-->',
      '## 概要',
      '',
      '認証を足す。',
      '二行目。',
      '',
      '## 影響',
      '```',
      '',
      '### 変更メモ apps/map/changes/auth.md',
      '',
      '```markdown',
      '# 認証',
      '',
      'なぜ変えたか。',
      '',
      '## verify <!-- core:a.ts#verify -->',
      '',
      '戻り値を 2 にした。',
      '',
      '## token',
      '',
      '別の関数。',
      '```',
      '',
      '## 変えた関数（追加 0・変更 1・削除 1）',
      '',
      '### 変更 `verify()` `core:a.ts#verify`',
      '',
      '- 今のコード: packages/core/src/a.ts:10-24',
      '- 今これを呼ぶもの: token()（packages/core/src/b.ts:3）、POST /token（エンドポイントの処理）（apps/hono/src/oidc-provider/endpoints/token/pipeline.ts:5）',
      '',
      '```diff',
      '@@ -10,3 +10,3 @@',
      ' export function verify() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '```',
      '',
      '### 削除 `gone()` `core:a.ts#gone`',
      '',
      '- 今のコード: 今の地図には無い（消えたか、名前かファイルが変わった）',
      '',
      '（差分なし）',
      '',
      '## 関数の外の変更（import、型、定数、エンドポイントの処理など）',
      '',
      '### packages/core/src/a.ts',
      '',
      '```diff',
      '@@ -1,1 +1,1 @@',
      "-import { x } from './x';",
      "+import { x, y } from './y';",
      '```',
      '',
      '## 地図に載せなかった差分',
      '',
      '- apps/nextjs/src/app/(ciba)/big.ts（差分が長いので地図に載せていない）',
      '',
      "`git show --diff-merges=first-parent --format= b11111111111 -- 'apps/nextjs/src/app/(ciba)/big.ts'` で読める。",
      '',
      '## コミット 1',
      '',
      '- c222222222 verify を直す（Claude）',
      '',
    ]);
  });

  it('should say why a change has no intent nor function, and when its diff and its notes could not be read', () => {
    const direct = history.entries[0] as HistoryEntry;
    const brief = changeBrief(map, history, direct, undefined);
    expect([brief.includes('PR が無い。コミットの件名が、何をしたかの記録である。'), brief.includes('関数カタログの関数は変えていない。')]).toEqual([true, true]);
    const unread = changeBrief(map, history, merged, undefined);
    expect([unread.includes('（差分を読めなかった）'), unread.includes('- apps/map/changes/auth.md（`git show b11111111111:apps/map/changes/auth.md`）')]).toEqual([true, true]);
  });

  it('should give no git command for the oldest commit of a shallow clone, whose parent git does not have', () => {
    const boundary = change({ commit: `7${'7'.repeat(39)}`, kind: 'direct', boundary: true, notes: ['apps/map/changes/x.md'] });
    const brief = changeBrief(map, history, boundary, undefined);
    expect([brief.includes('git show'), brief.includes('浅い clone の最も古いコミットなので、何を変えたかは分からない。')]).toEqual([false, true]);
  });

  it('should say that a function came with its file moved, and name both paths to read the file with git', () => {
    const moved = change({ commit: `8${'8'.repeat(39)}`, pr: 138, functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'added' }], detail: './x.json' });
    const movedDetail: HistoryDetail = { version: 1, commit: moved.commit, notes: [], files: [{ path: 'packages/core/src/a.ts', from: 'samples/old/a.ts', status: 'renamed', functions: [{ id: 'core:a.ts#verify', hunks: [] }], outside: [], omitted: 'change' }] };
    const brief = changeBrief(map, history, moved, movedDetail);
    expect(brief).toContain('（ファイルを samples/old/a.ts から packages/core/src/a.ts へ移した変更。前の履歴は元のファイルにある）\n\n（変更全体の差分が多いので、このファイルの差分は地図に載せていない。`git show --diff-merges=first-parent --format= 888888888888 -- samples/old/a.ts packages/core/src/a.ts` で読める）');
    expect(brief).toContain('- samples/old/a.ts → packages/core/src/a.ts（変更全体の差分が多いので、このファイルの差分は地図に載せていない）');
  });

  it('should fence a text that has backquotes so that they close nothing', () => {
    const brief = changeBrief(map, history, { ...merged, body: '```ts\ncode\n```' }, undefined);
    const lines = brief.split('\n');
    const at = lines.indexOf('### PR の本文');
    expect(lines.slice(at + 2, at + 7)).toEqual(['````markdown', '```ts', 'code', '```', '````']);
  });
});

describe('the outline of a large change', () => {
  it('should give the gist of the intent and the functions by the file they are in now, with the size of their diff and no diff', () => {
    const lines = changeBrief(map, history, merged, detail, { diffs: false }).split('\n');
    const intent = lines.indexOf('## 意図');
    expect(lines.slice(intent, intent + 6)).toEqual(['## 意図', '', '- PR の本文: 認証を足す。 二行目。', '- 変更メモ apps/map/changes/auth.md（節: verify、token）', '', '本文と変更メモの全文は、見取り図でない変更のブリーフにある。']);
    const functions = lines.indexOf('## 変えた関数（追加 0・変更 1・削除 1）');
    expect(lines.slice(functions, functions + 16)).toEqual([
      '## 変えた関数（追加 0・変更 1・削除 1）',
      '',
      '### packages/core/src/a.ts',
      '',
      '- 変更 `verify()` 10-24（+1 −1 行）',
      '',
      '### 今の地図に無い関数',
      '',
      '- 削除 `core:a.ts#gone`（差分なし）',
      '',
      '## 関数の外の変更（import、型、定数、エンドポイントの処理など）',
      '',
      '- packages/core/src/a.ts（+1 −1 行）',
      '',
      '## 地図に載せなかった差分',
      '',
    ]);
    expect(lines.some((line) => line.startsWith('```diff'))).toBe(false);
  });
});

describe('a function for an AI', () => {
  it('should find a function as a change note names it: by its id, its name, its root and its module, the functions of the history too', () => {
    expect([functionsNamed(map, history, 'core:a.ts#verify'), functionsNamed(map, history, 'verify()'), functionsNamed(map, history, 'experimental:verify'), functionsNamed(map, history, 'a.ts#verify'), functionsNamed(map, history, 'gone'), functionsNamed(map, history, 'none')]).toEqual([['core:a.ts#verify'], ['core:a.ts#verify', 'experimental:c.ts#verify'], ['experimental:c.ts#verify'], ['core:a.ts#verify'], ['core:a.ts#gone'], []]);
    expect(functionsNamed(map, history, 'verify', merged)).toEqual(['core:a.ts#verify']);
  });

  it('should name nothing by the names an object has of its own (constructor, toString)', () => {
    expect([functionsNamed(map, history, 'constructor'), functionsNamed(map, history, 'toString'), placeOf(map, 'constructor')]).toEqual([[], [], undefined]);
    expect(functionBrief(map, history, 'constructor', new Map())).toContain('- 変えた変更: 0（新しい順）');
  });

  it('should write where the function is now and the changes that made it, newest first, with the gist of their intent, the note about it and their diff of it', () => {
    const brief = functionBrief(map, history, 'core:a.ts#verify', new Map([[merged.commit, detail]]), { limit: 1 });
    expect(brief.split('\n')).toEqual([
      '# `verify()` の変更の履歴',
      '',
      '- id: `core:a.ts#verify`',
      '- 今のコード: packages/core/src/a.ts:10-24',
      '- 今これを呼ぶもの: token()（packages/core/src/b.ts:3）、POST /token（エンドポイントの処理）（apps/hono/src/oidc-provider/endpoints/token/pipeline.ts:5）',
      '- 変えた変更: 2（新しい順）。差分は変更したときのもので、今のコードとは行がずれていることがある',
      ...READING,
      '',
      '## PR #209: クライアント認証を足す',
      '',
      '- キー: pr-209 · 2026-11-21 · 変更 · 作成者: Claude',
      '- 意図（PR の本文から）: 認証を足す。 二行目。',
      '',
      '変更メモ apps/map/changes/auth.md の「verify」:',
      '',
      '```markdown',
      '戻り値を 2 にした。',
      '```',
      '',
      '```diff',
      '@@ -10,3 +10,3 @@',
      ' export function verify() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '```',
      '',
      'ほか 1 件の古い変更（--limit で増やせる）。',
      '',
    ]);
  });

  it('should give a note section to the function its root or module names, as the map does, and to no other function of that name', () => {
    const both = change({ commit: `5${'5'.repeat(39)}`, pr: 194, functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'modified' }, { id: 'experimental:c.ts#verify', name: 'verify', status: 'modified' }], notes: ['n.md'], detail: './y.json' });
    const notes: HistoryDetail = { version: 1, commit: both.commit, notes: [{ path: 'n.md', text: '## experimental:verify\n\nEXPERIMENTAL ONLY\n\n## a.ts#verify\n\nCORE BY MODULE\n\n## verify\n\nBOTH\n' }], files: [] };
    const two: HistoryData = { version: 1, entries: [both], functions: { 'core:a.ts#verify': [0], 'experimental:c.ts#verify': [0] } };
    const core = functionBrief(map, two, 'core:a.ts#verify', new Map([[both.commit, notes]]));
    const experimental = functionBrief(map, two, 'experimental:c.ts#verify', new Map([[both.commit, notes]]));
    expect([core.includes('EXPERIMENTAL ONLY'), core.includes('CORE BY MODULE'), core.includes('BOTH')]).toEqual([false, true, true]);
    expect([experimental.includes('EXPERIMENTAL ONLY'), experimental.includes('CORE BY MODULE'), experimental.includes('BOTH')]).toEqual([true, false, true]);
  });

  it('should say a change whose diff could not be read could not be read, and keep to one change when asked', () => {
    const unread = functionBrief(map, history, 'core:a.ts#verify', new Map());
    expect([unread.includes('変更メモ（apps/map/changes/auth.md）を読めなかった。'), unread.split('（差分を読めなかった）').length - 1]).toEqual([true, 2]);
    const only = functionBrief(map, history, 'core:a.ts#verify', new Map([[merged.commit, detail]]), { only: history.entries[2] as HistoryEntry });
    expect([only.split('\n')[0], only.includes('## PR #150: verify を足す'), only.includes('## PR #209')]).toEqual(['# `verify()` の変更の履歴（PR #150: verify を足す）', true, false]);
    expect(functionBrief(map, history, 'core:a.ts#verify', new Map(), { only: history.entries[0] as HistoryEntry })).toContain('この変更は、この関数を変えていない。');
  });

  it('should send an endpoint body, which the history does not follow, to the history of its lines in git', () => {
    expect(functionBrief(map, history, 'hono:token#body', new Map())).toContain('エンドポイントの処理は、変更の履歴が関数ごとには追わない（変更のブリーフでは「関数の外の変更」に入る）。この行の履歴は `git log --first-parent -L 5,40:apps/hono/src/oidc-provider/endpoints/token/pipeline.ts` で読める。');
  });
});

describe('the list of the changes', () => {
  it('should list the latest changes with their keys and the functions they touched, up to the commit it was read to', () => {
    expect(listBrief(history, 2).split('\n')).toEqual([
      '# main に入った変更（新しい順、2 / 3。d333333333 まで）',
      '',
      '- d333333333 2026-11-22 （PR なし） typo（関数の変更なし）',
      '- pr-209 2026-11-21 #209 クライアント認証を足す（関数 +0 ~1 -1）',
      '',
    ]);
  });
});

describe('the pieces of a brief', () => {
  it('should write a hunk as a unified diff and the place of a frame by its file', () => {
    expect(unifiedHunk({ base: 3, head: 3, lines: [' a', '-b', '+c', '+d'] })).toBe('@@ -3,2 +3,3 @@\n a\n-b\n+c\n+d');
    expect([placeOf(map, 'hono:token#body'), placeOf(map, 'core:a.ts#gone')]).toEqual([{ path: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', start: 5, end: 40 }, undefined]);
  });
});
