import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionEntry, HistoryData, HistoryDetail, HistoryEntry, MapData, OpFlow } from '../types';
import { aiMarkdown, changeUrl, changesOf, commitUrl, endpointsReached, entryKey, entryOf, filterEntries, functionCounts, unifiedHunk } from './history';

/** A change that reached main. */
function change(fields: Partial<HistoryEntry> & Pick<HistoryEntry, 'commit' | 'title' | 'kind'>): HistoryEntry {
  return { date: '2026-11-21T10:00:00+09:00', authors: ['Claude'], commits: [], files: [], functions: [], notes: [], additions: 0, deletions: 0, ...fields };
}

const history: HistoryData = {
  version: 1,
  repository: 'owner/name',
  entries: [
    change({ commit: 'aaaaaaaaaaaa1', title: 'fix(map): slow the playback down', kind: 'direct' }),
    change({ commit: 'bbbbbbbbbbbb2', title: 'クライアント認証を足す', kind: 'merge', pr: 209, branch: 'claude/auth', functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'modified' }, { id: 'core:a.ts#gone', name: 'gone', status: 'removed' }] }),
    change({ commit: 'cccccccccccc3', title: 'Add verify', kind: 'squash', pr: 12, functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'added' }] }),
  ],
  functions: { 'core:a.ts#verify': [1, 2], 'core:a.ts#gone': [1] },
};

describe('the changes of the history', () => {
  it('should find a pull request another change brought by its key, and count a merge without a pull request as one without', () => {
    const carrier = change({ commit: 'ddddddddddd4', title: "Merge branch 'main'", kind: 'merge', carried: [{ pr: 182, title: 'Add hashed secrets', commit: 'eeee' }] });
    const withCarrier = { ...history, entries: [...history.entries, carrier] };
    expect([entryOf(withCarrier, 'pr-182')?.commit, filterEntries(withCarrier, { query: '#182', code: false, direct: false }).length, filterEntries(withCarrier, { query: '', code: false, direct: true }).map((entry) => entry.commit)]).toEqual(['ddddddddddd4', 1, ['aaaaaaaaaaaa1', 'ddddddddddd4']]);
  });

  it('should key a pull request by its number and a push by its commit, and find either key', () => {
    const [direct, merged] = history.entries as [HistoryEntry, HistoryEntry];
    expect([entryKey(direct), entryKey(merged), entryOf(history, 'pr-209')?.title, entryOf(history, 'aaaaaaaaaa')?.title, entryOf(history, 'aaaaaaa')?.title, entryOf(history, 'pr-1')]).toEqual(['aaaaaaaaaa', 'pr-209', 'クライアント認証を足す', 'fix(map): slow the playback down', 'fix(map): slow the playback down', undefined]);
  });

  it('should narrow the list by words, by the changes of code and by the pushes without a pull request', () => {
    const titles = (filter: Parameters<typeof filterEntries>[1]) => filterEntries(history, filter).map((entry) => entry.title);
    expect([titles({ query: '#209', code: false, direct: false }), titles({ query: 'verify', code: false, direct: false }), titles({ query: '', code: true, direct: false }), titles({ query: '', code: false, direct: true }), titles({ query: 'auth クライアント', code: false, direct: false })]).toEqual([
      ['クライアント認証を足す'],
      ['クライアント認証を足す', 'Add verify'],
      ['クライアント認証を足す', 'Add verify'],
      ['fix(map): slow the playback down'],
      ['クライアント認証を足す'],
    ]);
  });

  it('should count the functions a change added, changed and removed, and list the changes of a function newest first', () => {
    expect([functionCounts(history.entries[1] as HistoryEntry), changesOf(history, 'core:a.ts#verify').map(({ entry, status }) => `${entry.pr} ${status}`)]).toEqual([{ added: 0, modified: 1, removed: 1 }, ['209 modified', '12 added']]);
  });

  it('should link a pull request, a commit and a file at a commit on GitHub, and nothing without the repository', () => {
    const [direct, merged] = history.entries as [HistoryEntry, HistoryEntry];
    expect([changeUrl(history, merged), changeUrl(history, direct), commitUrl(history, 'abc', 'apps/map/changes/x y.md'), changeUrl({ ...history, repository: undefined } as unknown as HistoryData, merged)]).toEqual([
      'https://github.com/owner/name/pull/209',
      'https://github.com/owner/name/commit/aaaaaaaaaaaa1',
      'https://github.com/owner/name/blob/abc/apps/map/changes/x%20y.md',
      undefined,
    ]);
  });
});

describe('the endpoints a change reaches now', () => {
  it('should follow the functions that still exist up to the steps and the roots that reach them', () => {
    const card = (id: string, calledBy: string[] = []) => ({ id, name: id.slice(id.indexOf('#') + 1), calledBy }) as unknown as FunctionEntry;
    const data = { functions: { 'core:a.ts#verify': card('core:a.ts#verify', ['hono:s.ts#authenticate']), 'hono:s.ts#authenticate': card('hono:s.ts#authenticate'), 'hono:p.ts#handle': card('hono:p.ts#handle') } } as unknown as MapData;
    const flow = {
      endpoints: [
        { id: 'token', root: 'endpoint:token', steps: [{ id: 'authenticate', functionId: 'hono:s.ts#authenticate', calls: [] }] },
        { id: 'userinfo', root: 'hono:p.ts#handle', steps: [] },
        { id: 'jwks', root: 'endpoint:jwks', steps: [] },
      ],
    } as unknown as OpFlow;
    const entry = change({ commit: 'd', title: 't', kind: 'direct', functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'modified' }, { id: 'hono:p.ts#handle', name: 'handle', status: 'added' }, { id: 'core:a.ts#gone', name: 'gone', status: 'removed' }] });
    expect(endpointsReached(data, flow, entry).map((endpoint) => endpoint.id)).toEqual(['token', 'userinfo']);
  });

  it('should reach an endpoint whose body calls the function, and one whose own file holds it, as the page of a function does', () => {
    const card = (id: string, calledBy: string[], module: string) => ({ id, name: id.slice(id.indexOf('#') + 1), package: 'nextjs', module, calledBy }) as unknown as FunctionEntry;
    const data = { functions: { 'nextjs:app/userinfo/route.ts#extractAccessToken': card('nextjs:app/userinfo/route.ts#extractAccessToken', ['endpoint:nextjs:userinfo'], 'app/userinfo/route.ts'), 'core:t.ts#check': card('core:t.ts#check', ['nextjs:app/token/helpers.ts#read'], 't.ts'), 'nextjs:app/token/helpers.ts#read': card('nextjs:app/token/helpers.ts#read', ['endpoint:nextjs:token'], 'app/token/helpers.ts') } } as unknown as MapData;
    const flow = {
      endpoints: [
        { id: 'userinfo', root: 'endpoint:nextjs:userinfo', module: 'userinfo/route.ts', steps: [] },
        { id: 'token', root: 'endpoint:nextjs:token', module: 'token/route.ts', steps: [] },
        { id: 'jwks', root: 'endpoint:nextjs:jwks', module: 'jwks/route.ts', steps: [] },
      ],
    } as unknown as OpFlow;
    const entry = change({ commit: 'e', title: 't', kind: 'merge', pr: 167, functions: [{ id: 'nextjs:app/userinfo/route.ts#extractAccessToken', name: 'extractAccessToken', status: 'modified' }, { id: 'core:t.ts#check', name: 'check', status: 'modified' }] });
    expect(endpointsReached(data, flow, entry).map((endpoint) => endpoint.id)).toEqual(['userinfo', 'token']);
  });
});

describe('the diff of a change for a reader and an AI', () => {
  const detail: HistoryDetail = {
    version: 1,
    commit: 'bbbbbbbbbbbb2',
    notes: [{ path: 'apps/map/changes/auth.md', text: '# 認証\n\nなぜ変えたか。\n' }],
    files: [
      {
        path: 'packages/core/src/a.ts',
        status: 'modified',
        functions: [{ id: 'core:a.ts#verify', hunks: [{ base: 10, head: 10, lines: [' export function verify() {', '-  return 1;', '+  return 2;', ' }'] }] }, { id: 'core:a.ts#gone', hunks: [] }],
        outside: [{ base: 1, head: 1, lines: ["-import { x } from './x';", "+import { x, y } from './y';"] }],
      },
      { path: 'packages/core/src/big.ts', status: 'added', functions: [], outside: [], omitted: 'file' },
    ],
  };
  const merged = history.entries[1] as HistoryEntry;

  it('should write a hunk as a unified diff', () => {
    expect(unifiedHunk(detail.files[0]?.functions[0]?.hunks[0] as HistoryDetail['files'][number]['outside'][number])).toEqual('@@ -10,3 +10,3 @@\n export function verify() {\n-  return 1;\n+  return 2;\n }');
  });

  it('should write the intent, the endpoints and the diff of the provider\'s code only, function by function, as Markdown', () => {
    const endpoint = { id: 'token', methods: ['POST'], path: '/token', label: 'トークンエンドポイント' } as unknown as FlowEndpoint;
    const markdown = aiMarkdown(history, { ...merged, body: '## 概要\n認証を足す。' }, detail, [endpoint], 'hono');
    expect(markdown.split('\n')).toEqual([
      '# PR #209: クライアント認証を足す',
      '',
      '- main に入った日: 2026-11-21 · ブランチ: claude/auth · 作成者: Claude · https://github.com/owner/name/pull/209',
      '- この文書の差分は、OSS が出すコード（関数カタログの根のファイル）だけである。テスト、文書、道具の変更は含まない',
      '',
      '## PR の本文',
      '',
      '```markdown',
      '## 概要',
      '認証を足す。',
      '```',
      '',
      '## 変更メモ apps/map/changes/auth.md',
      '',
      '```markdown',
      '# 認証',
      '',
      'なぜ変えたか。',
      '```',
      '',
      '## 今の地図で届くエンドポイント（hono）',
      '',
      '- POST /token（トークンエンドポイント）',
      '',
      '## 変えた関数（追加 0・変更 1・削除 1）',
      '',
      '### 変更 `core:a.ts#verify`（packages/core/src/a.ts）',
      '',
      '```diff',
      '@@ -10,3 +10,3 @@',
      ' export function verify() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '```',
      '',
      '### 削除 `core:a.ts#gone`（packages/core/src/a.ts）',
      '',
      '（差分なし）',
      '',
      '## 関数の外の変更（import、型、定数など）',
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
      '- packages/core/src/big.ts（差分が長いので地図に載せていない）',
      '',
    ]);
  });
});

describe('the pull requests a change brought, for an AI', () => {
  it('should write the text of each pull request the change brought with its intent', () => {
    const carrier = change({ commit: 'f', title: "Merge branch 'main'", kind: 'merge', carried: [{ pr: 182, title: 'Add hashed secrets', commit: 'e', body: 'Why hashed.' }] });
    expect(aiMarkdown(history, carrier, undefined, [], 'hono').split('\n').slice(4, 10)).toEqual(['', '## この変更で main に入った PR #182: Add hashed secrets', '', '```markdown', 'Why hashed.', '```']);
  });
});

describe('the diff of the places the reader chose', () => {
  it('should keep in the Markdown only the functions and the files chosen, and say so', () => {
    const detail: HistoryDetail = {
      version: 1,
      commit: 'c',
      notes: [],
      files: [{ path: 'packages/core/src/a.ts', status: 'modified', functions: [{ id: 'core:a.ts#verify', hunks: [{ base: 9, head: 9, lines: ['-c', '+d'] }] }, { id: 'core:a.ts#gone', hunks: [] }], outside: [{ base: 1, head: 1, lines: ['-a', '+b'] }] }],
    };
    const markdown = aiMarkdown(history, history.entries[1] as HistoryEntry, detail, [], 'hono', new Set(['core:a.ts#verify']));
    expect([markdown.includes('`core:a.ts#verify`'), markdown.includes('`core:a.ts#gone`'), markdown.includes('## 関数の外の変更'), markdown.includes('読み手が選んだ 1 か所')]).toEqual([true, false, false, true]);
  });
});
