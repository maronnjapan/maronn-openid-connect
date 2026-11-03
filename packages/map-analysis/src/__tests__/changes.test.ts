import { describe, expect, it } from 'vitest';
import { changesMarkdown, diffLines, hunksOf, parseNameStatus, pullRequestOf } from '../changes.js';
import type { FrameChangeEntry, MapChanges } from '../model.js';

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

  it('should list first the changes without an explanation, with a draft of the sections the check needs', () => {
    const markdown = changesMarkdown(changes([frame({ required: true, reach: [way] }), frame({ id: 'endpoint:token', name: 'token', body: true, module: 'oidc-provider/endpoints/token/pipeline.ts', required: true })]));
    expect(markdown.startsWith('### 説明の無い変更（2）')).toBe(true);
    expect(markdown).toContain('| 要説明 | `f()` | core a.ts:3 | 条件 `x` を足した（条件 +1） | token |');
    expect(markdown).toContain('| 要説明 | `token`（エンドポイントの処理） | core oidc-provider/endpoints/token/pipeline.ts:3 | 条件 `x` を足した（条件 +1） | （エンドポイントそのもの） |');
    expect(markdown).toContain('## f <!-- core:a.ts#f -->');
    expect(markdown).toContain('| 札 | 関数 | 場所 | 自動要約 | 届くエンドポイント | メモ |');
  });

  it('should show the first line of the note of an explained change, and no list of the unexplained when there is none', () => {
    const markdown = changesMarkdown(changes([frame({ documented: true, noteLine: '境界をそろえる。', required: true, reach: [way, { ...way, source: 'nextjs', frameworks: ['nextjs'] }] })]));
    expect(markdown).not.toContain('説明の無い変更');
    expect(markdown).toContain('| 変更 | `f()` | core a.ts:3 | 条件 `x` を足した（条件 +1） | token, token (nextjs) | 境界をそろえる。 |');
  });
});
