import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLine, commentBody, fitted, LINKS_PLACE, linesOutsideDetails, linkLines, MARKER, MAX_BODY } from './map-comment.mjs';

const build = { headSha: 'abc123', runUrl: 'https://github.com/o/r/actions/runs/1', codecov: 'https://app.codecov.io/gh/o/r/pull/7' };
const changes = ['**確かめること**', '- 説明の無い変更 0', '', LINKS_PLACE, '', '<details><summary>変わった関数 1（変更 1）</summary>', '', '| 札 |', '|---|', '| 変更 |', '', '</details>', ''].join('\n');

describe('commentBody', () => {
  it('should put the links where the changes leave their place, and end with one line about the build', () => {
    const body = commentBody({ ...build, changes, url: 'https://pr-7.example.workers.dev/', mode: 'preview', outcome: 'success' });
    assert.deepEqual(body.split('\n').slice(0, 7), [MARKER, '## OIDC Provider Map', '', '**確かめること**', '- 説明の無い変更 0', '', '**開く**']);
    assert.ok(body.includes('\n**開く**\n[変更](https://pr-7.example.workers.dev/#changes) · [テスト](https://pr-7.example.workers.dev/tests/#/pr) · [Codecov](https://app.codecov.io/gh/o/r/pull/7)\n\n<details>'));
    assert.ok(body.endsWith('</details>\n\nBuilt from abc123 · [Run](https://github.com/o/r/actions/runs/1) (artifact `oidc-provider-map`)'));
    assert.ok(!body.includes(LINKS_PLACE));
  });

  it('should put the links at the line of their place only, not where a note quotes it', () => {
    const quoted = [`**メモ** — リンクは \`${LINKS_PLACE}\` の行に置く。`, '', changes].join('\n');
    const lines = commentBody({ ...build, changes: quoted, url: 'u', mode: 'preview', outcome: 'success' }).split('\n');
    assert.equal(lines[3], `**メモ** — リンクは \`${LINKS_PLACE}\` の行に置く。`);
    assert.deepEqual(lines.slice(lines.indexOf('**開く**'), lines.indexOf('**開く**') + 2), ['**開く**', '[変更](u#changes) · [テスト](u/tests/#/pr) · [Codecov](https://app.codecov.io/gh/o/r/pull/7)']);
    assert.equal(lines.indexOf('**開く**'), lines.indexOf('- 説明の無い変更 0') + 2);
  });

  it('should warn first when the check of the build failed, and put the links first when the build wrote no changes', () => {
    const body = commentBody({ ...build, buildFailed: true, url: '', outcome: 'skipped' });
    assert.deepEqual(body.split('\n').slice(2, 7), ['', '> [!WARNING]', body.split('\n')[4], '', '**開く**']);
    assert.match(body, /地図のビルドの検査が落ちました。下の「説明の無い変更」/);
    assert.ok(body.includes('\n[Codecov](https://app.codecov.io/gh/o/r/pull/7)\n\nBuilt from abc123'));
  });
});

describe('linkLines / buildLine', () => {
  it('should link Codecov alone without a preview URL', () => {
    assert.deepEqual(linkLines({ url: '', codecov: 'c' }), ['**開く**', '[Codecov](c)']);
  });

  it('should say how the preview is served only when it is not the Worker Preview at its URL', () => {
    const line = (preview) => buildLine({ ...build, ...preview }).replace('Built from abc123 · [Run](https://github.com/o/r/actions/runs/1) (artifact `oidc-provider-map`)', '');
    assert.deepEqual(
      [
        line({ url: 'u', mode: 'preview', outcome: 'success' }),
        line({ url: 'u', mode: 'worker', outcome: 'success' }),
        line({ url: '', mode: '', outcome: 'skipped' }),
        line({ url: '', mode: 'worker', outcome: 'success' }),
        line({ url: '', mode: '', note: '', outcome: 'failure' }),
        line({ url: '', mode: '', note: 'Worker x', outcome: 'failure' }),
      ],
      [
        '',
        ' · Worker Previews failed: the preview is a Worker of this pull request.',
        ' · No preview: this run has no Cloudflare secrets; serve `dist/` of the artifact statically.',
        ' · No preview URL: the Worker of this pull request was deployed, but its URL was not found; see the run.',
        ' · No preview: the deploy failed; see the run.',
        ' · No preview: the deploy failed (Worker x); see the run.',
      ],
    );
  });
});

describe('linesOutsideDetails', () => {
  it('should count the lines outside every fold, with the lines that open and close one, and none inside', () => {
    assert.equal(linesOutsideDetails('a\n<details><summary>s</summary>\n\ninside\n<details>\nnested\n</details>\n\n</details>\nb\n'), 4);
    assert.equal(linesOutsideDetails('<details><summary>one line</summary> x </details>\nafter'), 2);
  });

  it('should not take a tag in the middle of a line (a code span, the title of a test) for a fold', () => {
    assert.equal(linesOutsideDetails('**メモ** — 表を `<details>` に畳む。\n<details><summary>s</summary>\n\n- should count the lines outside every <details>\n\n</details>\nb'), 4);
  });
});

describe('fitted', () => {
  it('should keep a body GitHub takes as it is, and else leave the lines of the folds out, then cut the rest', () => {
    const fold = ['<details><summary>変わった関数 1</summary>', '', 'x'.repeat(MAX_BODY), '', '</details>'].join('\n');
    assert.equal(fitted('short'), 'short');
    const folded = fitted(['**確かめること**', '', fold, '', 'Built from abc'].join('\n'));
    assert.deepEqual(folded.split('\n'), ['**確かめること**', '', '<details><summary>変わった関数 1</summary>', '', '（コメントが GitHub の上限の 65,536 字を超えるので、中身を省いた）', '', '</details>', '', 'Built from abc']);
    const cut = fitted(['a'.repeat(MAX_BODY), 'b'].join('\n'));
    assert.equal(cut.length, MAX_BODY);
    assert.ok(cut.endsWith('（コメントが GitHub の上限の 65,536 字を超えるので、ここから後を省いた）'));
  });
});
