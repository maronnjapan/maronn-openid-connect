/**
 * The comment the map job of CI writes on a pull request: the changes the
 * build of the map wrote (apps/map/dist/data/changes.md, see
 * packages/map-analysis changesMarkdown), the links to the preview, and one
 * line about the build. The lists are folded in `<details>`; what stays
 * outside is meant to fit in 30 lines
 * (apps/map/docs/design-request-premises.md「PR のコメント」).
 *
 *   node .github/scripts/map-comment.mjs [changes.md]
 *       Print the comment for the changes of that file (default:
 *       apps/map/dist/data/changes.md) and, on the error output, how many
 *       lines of it are outside `<details>`. The environment gives the rest
 *       (commentBody): PREVIEW_URL, PREVIEW_MODE, PREVIEW_NOTE,
 *       PREVIEW_OUTCOME, BUILD_OUTCOME, RUN_URL, HEAD_SHA, CODECOV_URL.
 *
 * The workflow imports commentBody and posts what it returns
 * (.github/workflows/ci.yml, "Comment the Preview on the pull request").
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The line that marks the comment of the map among the comments of a pull request (map-preview.yml finds it by this too). */
export const MARKER = '<!-- oidc-provider-map-preview -->';
/** Where the changes leave the place of the links (packages/map-analysis/src/changes.ts LINKS_MARKER). */
export const LINKS_MARKER = '<!-- map-links -->';
/** The lines outside `<details>` the comment is meant to stay within. */
export const LINES_GUIDE = 30;

const WARNING =
  '> 地図のビルドの検査が落ちました。下の「説明の無い変更」に変更メモの節を足すか、「関連するテストに変更の無い実装の変更」にテストを足すか変更メモに `テストを変えない理由:` を書くか、検査の出力を Run で確かめてください（`pnpm --filter @maronn-openid-connect/map changes:draft` で雛形を作れます）。';

/**
 * The comment: the marker and the heading, a warning when the check of the
 * build failed, the changes with the links where they leave their place
 * (after them when they leave none), and a last line with the commit, the
 * run and what happened to the preview when there is no URL to link.
 */
export function commentBody(env, changes) {
  const url = (env.PREVIEW_URL ?? '').replace(/\/$/, '');
  const text = changes.trim();
  const links = [...(url !== '' && text !== '' ? [`[変更](${url}#changes)`] : []), ...(url !== '' ? [`[テスト](${url}/tests/#/pr)`] : []), ...(env.CODECOV_URL ? [`[Codecov](${env.CODECOV_URL})`] : [])];
  const open = links.length === 0 ? '' : `**開く**\n${links.join(' · ')}`;
  const preview =
    url !== ''
      ? env.PREVIEW_MODE === 'worker'
        ? 'Worker Previews failed: the preview is a Worker of this pull request.'
        : ''
      : env.PREVIEW_OUTCOME === 'skipped'
        ? 'No preview (no Cloudflare secrets for this run): serve `dist/` of the artifact statically.'
        : `The deploy of the preview failed (${env.PREVIEW_NOTE || 'see the run'}).`;
  const built = [`Built from ${env.HEAD_SHA}`, `[Run](${env.RUN_URL}) (artifact \`oidc-provider-map\`)`, ...(preview === '' ? [] : [preview])].join(' · ');
  const placed = text.includes(LINKS_MARKER) ? text.replace(LINKS_MARKER, () => open) : [text, open].filter((part) => part !== '').join('\n\n');
  return [MARKER, '## OIDC Provider Map', ...(env.BUILD_OUTCOME === 'failure' ? ['', '> [!WARNING]', WARNING] : []), ...(placed === '' ? [] : ['', placed]), '', built].join('\n');
}

/** The lines of a comment outside its `<details>` blocks, the blank ones included. */
export function linesOutsideDetails(body) {
  let depth = 0;
  let count = 0;
  for (const line of body.split('\n')) {
    const opens = (line.match(/<details[\s>]/g) ?? []).length;
    const closes = (line.match(/<\/details>/g) ?? []).length;
    if (depth === 0 && opens === 0) count += 1;
    depth = Math.max(0, depth + opens - closes);
  }
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'apps/map/dist/data/changes.md';
  const body = commentBody(process.env, existsSync(file) ? readFileSync(file, 'utf8') : '');
  console.log(body);
  console.error(`${linesOutsideDetails(body)} lines outside <details> (the guide is ${LINES_GUIDE}), ${body.length} characters`);
}
