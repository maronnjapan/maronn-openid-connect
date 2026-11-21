import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LINES_GUIDE, LINKS_MARKER, MARKER, commentBody, linesOutsideDetails } from './map-comment.mjs';

const ENV = {
  PREVIEW_URL: 'https://pr-9-map.example.workers.dev/',
  PREVIEW_MODE: 'preview',
  PREVIEW_OUTCOME: 'success',
  BUILD_OUTCOME: 'success',
  RUN_URL: 'https://github.com/o/r/actions/runs/1',
  HEAD_SHA: 'abc123',
  CODECOV_URL: 'https://app.codecov.io/gh/o/r/pull/9',
};

const CHANGES = [
  '**DPoP を加える** — DPoP を拡張機能として加える。',
  '',
  '**確かめること**',
  '- 説明の無い変更 0 · テストを変えていない変更 0',
  '- コメント +412 行、コード +380 行',
  '',
  LINKS_MARKER,
  '',
  '<details><summary>変わった関数 2（追加 1 · 変更 1）</summary>',
  '',
  '| 札 | 関数 |',
  '|---|---|',
  '| 追加 | `f()` |',
  '',
  '</details>',
  '',
  '<details><summary>テスト 1 → 2（追加 1 · 変更 0 · 名前の変更 0 · 削除 0）</summary>',
  '',
  'テストケース: +1',
  '',
  '</details>',
  '',
].join('\n');

describe('commentBody', () => {
  it('should put the links where the changes leave their place, and end with one line about the build', () => {
    assert.equal(
      commentBody(ENV, CHANGES),
      [
        MARKER,
        '## OIDC Provider Map',
        '',
        '**DPoP を加える** — DPoP を拡張機能として加える。',
        '',
        '**確かめること**',
        '- 説明の無い変更 0 · テストを変えていない変更 0',
        '- コメント +412 行、コード +380 行',
        '',
        '**開く**',
        '[変更](https://pr-9-map.example.workers.dev#changes) · [テスト](https://pr-9-map.example.workers.dev/tests/#/pr) · [Codecov](https://app.codecov.io/gh/o/r/pull/9)',
        '',
        '<details><summary>変わった関数 2（追加 1 · 変更 1）</summary>',
        '',
        '| 札 | 関数 |',
        '|---|---|',
        '| 追加 | `f()` |',
        '',
        '</details>',
        '',
        '<details><summary>テスト 1 → 2（追加 1 · 変更 0 · 名前の変更 0 · 削除 0）</summary>',
        '',
        'テストケース: +1',
        '',
        '</details>',
        '',
        'Built from abc123 · [Run](https://github.com/o/r/actions/runs/1) (artifact `oidc-provider-map`)',
      ].join('\n'),
    );
  });

  it('should warn first when the check of the build failed', () => {
    const lines = commentBody({ ...ENV, BUILD_OUTCOME: 'failure' }, CHANGES).split('\n');
    assert.deepEqual(lines.slice(0, 4), [MARKER, '## OIDC Provider Map', '', '> [!WARNING]']);
    assert.match(lines[4], /^> 地図のビルドの検査が落ちました。下の「説明の無い変更」に変更メモの節を足すか、「関連するテストに変更の無い実装の変更」に/);
  });

  it('should say why there is no preview to link, and still link Codecov and the run', () => {
    const skipped = commentBody({ ...ENV, PREVIEW_URL: '', PREVIEW_OUTCOME: 'skipped' }, CHANGES);
    const failed = commentBody({ ...ENV, PREVIEW_URL: '', PREVIEW_OUTCOME: 'failure', PREVIEW_NOTE: 'wrangler exited 1' }, CHANGES);
    assert.ok(skipped.includes('**開く**\n[Codecov](https://app.codecov.io/gh/o/r/pull/9)\n'));
    assert.ok(skipped.endsWith('Built from abc123 · [Run](https://github.com/o/r/actions/runs/1) (artifact `oidc-provider-map`) · No preview (no Cloudflare secrets for this run): serve `dist/` of the artifact statically.'));
    assert.ok(failed.endsWith(' · The deploy of the preview failed (wrangler exited 1).'));
  });

  it('should say that the preview is the fallback Worker when Worker Previews failed', () => {
    assert.ok(commentBody({ ...ENV, PREVIEW_MODE: 'worker' }, CHANGES).endsWith(' · Worker Previews failed: the preview is a Worker of this pull request.'));
  });

  it('should link the tests and the run when the build wrote no changes', () => {
    assert.equal(
      commentBody(ENV, ''),
      [MARKER, '## OIDC Provider Map', '', '**開く**', '[テスト](https://pr-9-map.example.workers.dev/tests/#/pr) · [Codecov](https://app.codecov.io/gh/o/r/pull/9)', '', 'Built from abc123 · [Run](https://github.com/o/r/actions/runs/1) (artifact `oidc-provider-map`)'].join('\n'),
    );
  });

  it('should put the links after changes that leave no place for them', () => {
    assert.ok(commentBody(ENV, '**確かめること**\n- 説明の無い変更 0\n').includes('- 説明の無い変更 0\n\n**開く**\n[変更]('));
  });
});

describe('linesOutsideDetails', () => {
  it('should count the lines outside the folded blocks, the blank ones included', () => {
    const body = commentBody(ENV, CHANGES);
    assert.equal(linesOutsideDetails(body), 15);
    assert.ok(linesOutsideDetails(body) <= LINES_GUIDE);
  });

  it('should count nothing of a block that opens and closes on one line, nor of the lines between an opening and a closing', () => {
    assert.equal(linesOutsideDetails(['a', '<details><summary>s</summary>x</details>', 'b', '<details>', 'c', '', '</details>', 'd'].join('\n')), 3);
  });
});

describe('LINKS_MARKER', () => {
  it('should be the marker the analysis leaves in the changes', () => {
    const source = readFileSync(new URL('../../packages/map-analysis/src/changes.ts', import.meta.url), 'utf8');
    assert.ok(source.includes(`export const LINKS_MARKER = '${LINKS_MARKER}';`));
  });
});
