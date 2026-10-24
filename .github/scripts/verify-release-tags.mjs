/**
 * changeset publish が打ったタグを changesets/action が origin へ push したことを検証する。
 *
 * 【なぜ必要か】
 * changesets/action は changeset publish が publish したパッケージを CLI の出力から読み取り、
 * それをもとにタグの push・GitHub Release の作成・published / published-packages 出力を行う。
 * 読み取れなくても publish 自体は成功しているので、action は「何も publish されなかった」として
 * 成功で終わる。タグ・GitHub Release・provenance 検証（published が true のときだけ走る）の
 * 3 つが黙って止まり、run は緑のまま気づく手がかりが残らない。
 * 実際に @changesets/cli 3 系が `New tag:` 行を出さなくなったのに changesets/action@v1 のまま
 * だったため、2026-09-03 から 7 週間この状態で publish が続いた（RELEASE.md
 * 「@changesets/cli と changesets/action は major を揃えて上げる」）。
 *
 * CLI と action の組み合わせは test:release-contract が PR の時点で検査するが、検出が壊れる原因は
 * それだけではない。ci:publish が CHANGESETS_OUTPUT を changeset publish まで渡さなくなる、
 * action 側の不具合、タグの push の失敗（action は警告で済ませる）などがある。
 * そこで原因ではなく結果を検査する。
 *
 * 【判定の方針】
 * - changeset publish は publish できたパッケージのタグ（`<name>@<version>`）をローカルの HEAD に打つ。
 *   checkout は origin にあるタグしか持ってこないので、HEAD にあって origin に無い
 *   `<name>@<main のバージョン>` のタグは「この run の changeset publish が作ったのに、
 *   action が push しなかったタグ」になる。1 つでもあれば落とす。
 * - origin にあるかは `git ls-remote` で照会する。npm registry は照会しないので、
 *   publish 直後の反映の遅れ（RELEASE.md「publish 直後の registry を照会しない理由」）に左右されない。
 * - この run が publish しなかったバージョンは対象外。HEAD にタグが打たれないので、
 *   2026-09-03〜10-24 にタグ無しで publish されたバージョンでは落ちない。
 * - version 段階の run は対象外（changeset publish が走らない）。段階は changesets/action の
 *   `has-changesets` 出力で判断し、値が読めなければ検査を飛ばさずに落とす。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseReleaseStage, readPublishablePackagesAt } from './verify-release-published.mjs';

/** `git ls-remote --tags --refs` の出力からタグ名を取り出す。 */
export function parseRemoteTags(lsRemoteOutput) {
  return lsRemoteOutput
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref) => typeof ref === 'string' && ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length));
}

/**
 * この run の changeset publish が HEAD に打ったのに origin に無いタグを選ぶ。
 * タグ名は Changesets がモノレポで使う `<name>@<version>`。
 */
export function selectUnpushedReleaseTags({ packages, localTagsAtHead, remoteTags }) {
  return packages
    .map(({ name, version }) => `${name}@${version}`)
    .filter((tag) => localTagsAtHead.includes(tag) && !remoteTags.includes(tag));
}

export function assertReleaseTagsArePushed(unpushedTags) {
  if (unpushedTags.length === 0) return;

  throw new Error(
    `changeset publish が作ったタグが origin にありません: ${unpushedTags.join(', ')}\n` +
      'publish には成功していますが changesets/action がそれを検出していないため、' +
      'タグの push・GitHub Release の作成・provenance 検証が行われていません。\n' +
      '@changesets/cli と changesets/action の major の組み合わせ（pnpm run test:release-contract）と、' +
      'publish-script が CHANGESETS_OUTPUT を changeset publish まで渡しているかを確認してください。' +
      'action のログに "Failed to create git tag" の警告があれば、タグの push に失敗しています。\n' +
      'publish 済みのバージョンは re-run しても changeset publish がタグを作り直さないので、' +
      'タグと GitHub Release は手で作ってください（RELEASE.md「changesets/action が publish を検出したことを検証する」）。',
  );
}

function git(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function verifyReleaseTags() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const commit = process.env.GITHUB_SHA ?? 'HEAD';
  const stage = parseReleaseStage(process.env.HAS_CHANGESETS);

  if (stage === 'version') {
    console.log('Release tags check skipped: この run は version 段階で、changeset publish を実行していません');
    return;
  }

  const packages = readPublishablePackagesAt(repositoryRoot, commit);
  const localTagsAtHead = git(repositoryRoot, ['tag', '--points-at', commit])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const remoteTags = parseRemoteTags(git(repositoryRoot, ['ls-remote', '--tags', '--refs', 'origin']));

  assertReleaseTagsArePushed(selectUnpushedReleaseTags({ packages, localTagsAtHead, remoteTags }));

  const releaseTags = packages
    .map(({ name, version }) => `${name}@${version}`)
    .filter((tag) => localTagsAtHead.includes(tag));
  console.log(
    releaseTags.length === 0
      ? 'Release tags verified: この run の changeset publish が打ったタグはありません'
      : `Release tags verified: ${releaseTags.join(', ')} は origin に push 済みです`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyReleaseTags();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
