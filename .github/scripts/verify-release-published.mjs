/**
 * main に載っているバージョンが npm に出ていることを検証する。
 *
 * 【なぜ必要か】
 * Release ワークフローは「未消化の changeset があれば version 段階、無ければ publish 段階」で
 * 分岐する。この分岐が何かの理由で version 段階に入り続けると、Version Packages PR を
 * マージしてバージョンが確定しても publish されないまま次の Version Packages PR が立つ。
 * ワークフローは成功扱いで終わるので、**npm だけが古いまま誰も気づけない**。
 * 実際にこの状態が起き、main が core 0.1.0 / cli 0.1.0 / experimental 0.0.3 まで進む一方で
 * npm は 3 つとも 0.0.1 のまま止まっていた（原因は RELEASE.md
 * 「なぜ version 確定コミットを基準にするのか」）。
 *
 * そこで Release の最後に「main の package.json のバージョンが registry にあるか」を突き合わせ、
 * publish 段階へ到達しなかった run を赤くする。publish されるべきものが publish されていない、
 * という状態そのものを検出するので、分岐が将来どんな理由で壊れても気づける。
 *
 * 【判定の方針】
 * - 比較対象は main の commit に入っている package.json（`git show <sha>:...`）。
 *   changesets/action は version 段階で release ブランチへ checkout するため、
 *   ワークツリーを読むとバンプ後のバージョンを読んでしまう。
 * - この run が publish 段階に入ったときは registry を照会しない。changeset publish は
 *   registry に無いバージョンをすべて publish し、1 つでも失敗すれば changesets/action の
 *   ステップごと落ちるので、ここまで来た時点で publish には到達している。
 *   npm は publish を受け付けてから packument に載せるまで数分かかり（実測 1〜7 分）、
 *   直後に照会すると publish に成功した run を落としてしまう。遅れに上限が無いので、
 *   待って引き直す方式では解消しない。
 *   段階は changesets/action の `hasChangesets` 出力で判断する（`false` が publish 段階）。
 * - version 段階に入った run では、main のバージョンはそれより前の publish 段階で
 *   npm に出ているはずなので、registry を 1 回照会して突き合わせる。
 * - main の commit に未消化の changeset が残っているときは検査しない。version 段階が
 *   正しい状態であり、publish は次の Version Packages PR のマージまで起きない。
 *   changeset も commit から読む。ワークツリーには `Ensure experimental release changeset`
 *   が書き出した changeset が居るので、それを数えると検出したい状態を見逃す。
 * - registry のほうが新しいのは publish 漏れではないので通す。
 * - publish 実績がまったく無い package は対象外。初回 publish は Trusted Publishing の
 *   chicken-and-egg で手動になる（RELEASE.md「初回 publish の注意」）。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const PACKAGE_GLOB_ROOT = 'packages';

/** registry のパッケージドキュメントから publish 済みバージョンを取り出す。未公開なら空配列。 */
export function parsePublishedVersions(registryDocument) {
  const versions = registryDocument?.versions;
  return versions === undefined || versions === null ? [] : Object.keys(versions);
}

/**
 * changesets/action の `hasChangesets` 出力から、この run が入った段階を読む。
 * action は changeset が 1 つも無いときだけ publish スクリプトを実行する。
 * 値が読めないとき（出力名が変わったなど）に検査を黙って飛ばすと publish 漏れを見逃すので落とす。
 */
export function parseReleaseStage(hasChangesets) {
  if (hasChangesets === 'false') return 'publish';
  if (hasChangesets === 'true') return 'version';

  throw new Error(
    `changesets/action の hasChangesets 出力を読めません: ${JSON.stringify(hasChangesets)}\n` +
      'release.yml の "Verify npm reflects the versions on main" に HAS_CHANGESETS として渡してください。',
  );
}

export function selectUnpublishedPackages(packages, publishedVersionsByName) {
  return packages
    .map(({ name, version }) => ({ name, version, publishedVersions: publishedVersionsByName[name] ?? [] }))
    .filter(({ publishedVersions }) => publishedVersions.length > 0)
    .filter(({ version, publishedVersions }) => !publishedVersions.includes(version))
    .map(({ name, version, publishedVersions }) => ({
      name,
      version,
      // registry の versions は publish 順に並ぶので、末尾が直近の publish になる
      latestPublishedVersion: publishedVersions[publishedVersions.length - 1],
    }));
}

/** main の commit に入っている未消化の changeset を取り出す。README・config は changeset ではない。 */
export function selectPendingChangesets(changesetDirectoryEntries) {
  return changesetDirectoryEntries.filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'));
}

/** registry と突き合わせずに通してよい理由を返す。突き合わせる必要があるときは null。 */
export function findReasonToSkipRegistryCheck({ stage, pendingChangesets }) {
  // changeset publish は registry に無いバージョンをすべて publish し、1 つでも失敗すれば
  // changesets/action のステップごと落ちる。publish 段階でここまで来たなら publish には到達している。
  // npm は publish を受け付けてから数分はバージョンを返さないので、照会すると成功した run を落とす。
  if (stage === 'publish') {
    return 'この run は publish 段階に入り changeset publish が成功しています（npm の公開は数分遅れるため照会しない）';
  }

  // changeset が残っているうちは version 段階が正しい。publish は次の Version Packages PR の
  // マージまで起きないので、この時点でバージョンが npm より先に進んでいても異常ではない。
  if (pendingChangesets.length > 0) return '未消化の changeset があるため version 段階が正しい状態です';

  return null;
}

export function assertMainVersionsArePublished({ packages, publishedVersionsByName }) {
  const unpublished = selectUnpublishedPackages(packages, publishedVersionsByName);
  if (unpublished.length === 0) return;

  const detail = unpublished
    .map(({ name, version, latestPublishedVersion }) => `${name}@${version} (npm の最新は ${latestPublishedVersion})`)
    .join(', ');

  throw new Error(
    `main のバージョンが npm に出ていません: ${detail}\n` +
      'main に未消化の changeset は無いので、このバージョンは Version Packages PR のマージで走った' +
      ' Release の publish 段階で npm に出ているはずです。\n' +
      'その run が version 段階に入っていたら、"Ensure experimental release changeset" が changeset を' +
      '作り直しています。\n' +
      'publish した直後なら npm の公開待ち（数分）なので、npm view で出たことを確かめてから re-run してください' +
      '（RELEASE.md「publish に到達したことを検証する」）。',
  );
}

function readManifestAt(repositoryRoot, commit, path) {
  try {
    // package が その commit に存在しないのは正常系なのでエラー出力は捨てる
    return JSON.parse(
      execFileSync('git', ['show', `${commit}:${path}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

/**
 * commit に入っている `.changeset/` のエントリを列挙する。
 *
 * ワークツリーではなく commit を見るのが要点。`Ensure experimental release changeset` は
 * ワークツリーに changeset を書き出すので、ワークツリーを見ると「未消化の changeset がある」と
 * 誤判定し、検出したい状態そのものを見逃す。
 */
export function listChangesetEntriesAt(repositoryRoot, commit) {
  try {
    return execFileSync('git', ['ls-tree', '--name-only', '-r', commit, '.changeset/'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  } catch {
    return [];
  }
}

export function readPublishablePackagesAt(repositoryRoot, commit) {
  return readdirSync(join(repositoryRoot, PACKAGE_GLOB_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readManifestAt(repositoryRoot, commit, `${PACKAGE_GLOB_ROOT}/${entry.name}/package.json`))
    .filter((manifest) => manifest !== null && manifest.name !== undefined && manifest.private !== true)
    .map(({ name, version }) => ({ name, version }));
}

async function fetchPublishedVersions(name) {
  const response = await fetch(`${REGISTRY_ORIGIN}/${name}`, { headers: { accept: 'application/json' } });

  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm registry へのバージョン問い合わせに失敗しました: ${name} (${response.status})`);

  return parsePublishedVersions(await response.json());
}

async function fetchPublishedVersionsByName(packages) {
  return Object.fromEntries(
    await Promise.all(packages.map(async ({ name }) => [name, await fetchPublishedVersions(name)])),
  );
}

async function verifyReleasePublished() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const commit = process.env.GITHUB_SHA ?? 'HEAD';
  const stage = parseReleaseStage(process.env.HAS_CHANGESETS);

  const pendingChangesets = selectPendingChangesets(listChangesetEntriesAt(repositoryRoot, commit));
  const reasonToSkip = findReasonToSkipRegistryCheck({ stage, pendingChangesets });
  if (reasonToSkip !== null) {
    console.log(`Release published check skipped: ${reasonToSkip}`);
    return;
  }

  const packages = readPublishablePackagesAt(repositoryRoot, commit);
  assertMainVersionsArePublished({ packages, publishedVersionsByName: await fetchPublishedVersionsByName(packages) });

  console.log(
    `Release published verified: ${packages.map(({ name, version }) => `${name}@${version}`).join(', ')}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyReleasePublished();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
