/**
 * The comment of the OIDC Provider Map on a pull request, which the step
 * "Comment the Preview on the pull request" of the map job (ci.yml) writes
 * and rewrites on every push: the changes the build of the map wrote
 * (apps/map/dist/data/changes.md, packages/map-analysis changesMarkdown),
 * with the links to the preview, the tests and Codecov where the changes
 * leave their place, and one line about the build. The changes keep
 * outside `<details>` only what to check; the step logs how many lines that is.
 *
 *   node .github/scripts/map-comment.mjs [changes.md]
 *       Print the body for the changes in the file (none without one), with
 *       the preview and the run from the environment of the step:
 *       PREVIEW_URL, PREVIEW_MODE, PREVIEW_NOTE and PREVIEW_OUTCOME
 *       (map-preview.mjs create), BUILD_OUTCOME, RUN_URL, HEAD_SHA and
 *       CODECOV_URL; and the number of its lines outside `<details>`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The line the comment is found by (map-preview.yml rewrites it when the pull request closes). */
export const MARKER = '<!-- oidc-provider-map-preview -->';

/** The line of changes.md the links go to: LINKS_PLACE of packages/map-analysis/src/changes.ts. */
export const LINKS_PLACE = '<!-- oidc-provider-map-links -->';

/** The links of the comment: the changes and the tests of the preview when it has a URL, and Codecov. */
export function linkLines({ url, codecov }) {
  const preview = url ? [`[変更](${url}#changes)`, `[テスト](${url.replace(/\/$/, '')}/tests/#/pr)`] : [];
  return ['**開く**', [...preview, `[Codecov](${codecov})`].join(' · ')];
}

/** The last line: the commit and the run, and the preview when it is not the Worker Preview of the pull request at its URL. */
export function buildLine({ headSha, runUrl, url, mode, note, outcome }) {
  const preview = url
    ? mode === 'worker'
      ? ' · Worker Previews failed: the preview is a Worker of this pull request.'
      : ''
    : outcome === 'skipped'
      ? ' · No preview: this run has no Cloudflare secrets; serve `dist/` of the artifact statically.'
      : mode === 'worker'
        ? ' · No preview URL: the Worker of this pull request was deployed, but its URL was not found; see the run.'
        : ` · No preview: the deploy failed${note ? ` (${note})` : ''}; see the run.`;
  return `Built from ${headSha} · [Run](${runUrl}) (artifact \`oidc-provider-map\`)${preview}`;
}

/** The body of the comment (see the module comment). */
export function commentBody({ changes = '', buildFailed = false, codecov, ...build }) {
  const warning = buildFailed
    ? [
        '> [!WARNING]',
        '> 地図のビルドの検査が落ちました。下の「説明の無い変更」に変更メモの節を足すか、「関連するテストに変更の無い実装の変更」にテストを足すか変更メモに `テストを変えない理由:` を書くか、検査の出力を Run で確かめてください（`pnpm --filter @maronn-openid-connect/map changes:draft` で雛形を作れます）。',
        '',
      ]
    : [];
  const links = linkLines({ url: build.url, codecov }).join('\n');
  const text = changes.trim();
  const body = text.includes(LINKS_PLACE) ? text.replace(LINKS_PLACE, links) : [links, ...(text === '' ? [] : ['', text])].join('\n');
  return [MARKER, '## OIDC Provider Map', '', ...warning, body, '', buildLine(build)].join('\n');
}

/** The lines of a Markdown text a reader sees with every `<details>` folded: those outside them, with the lines that open and close one. */
export function linesOutsideDetails(markdown) {
  let depth = 0;
  let outside = 0;
  for (const line of markdown.replace(/\n$/, '').split('\n')) {
    const before = depth;
    depth = Math.max(0, depth + (line.match(/<details[\s>]/g) ?? []).length - (line.match(/<\/details>/g) ?? []).length);
    if (before === 0 || depth === 0) outside += 1;
  }
  return outside;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  const env = process.env;
  const body = commentBody({
    changes: file === undefined ? '' : readFileSync(file, 'utf8'),
    url: env.PREVIEW_URL ?? '',
    mode: env.PREVIEW_MODE ?? '',
    note: env.PREVIEW_NOTE ?? '',
    outcome: env.PREVIEW_OUTCOME ?? '',
    buildFailed: env.BUILD_OUTCOME === 'failure',
    runUrl: env.RUN_URL ?? '',
    headSha: env.HEAD_SHA ?? '',
    codecov: env.CODECOV_URL ?? '',
  });
  console.log(body);
  console.error(`${linesOutsideDetails(body)} lines outside <details>, ${body.split('\n').length} in all, ${body.length.toLocaleString('en-US')} characters`);
}
