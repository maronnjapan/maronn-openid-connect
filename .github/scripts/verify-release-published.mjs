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

export function assertMainVersionsArePublished(packages, publishedVersionsByName) {
  const unpublished = selectUnpublishedPackages(packages, publishedVersionsByName);
  if (unpublished.length === 0) return;

  const detail = unpublished
    .map(({ name, version, latestPublishedVersion }) => `${name}@${version} (npm の最新は ${latestPublishedVersion})`)
    .join(', ');

  throw new Error(
    `main のバージョンが npm に出ていません: ${detail}\n` +
      'Version Packages PR がマージされてバージョンが確定したのに publish 段階へ到達していません。\n' +
      '未消化の changeset が残り続けて changesets/action が version 段階に入り直していないかを' +
      '確認してください（RELEASE.md「publish に到達したことを検証する」）。',
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

async function verifyReleasePublished() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const commit = process.env.GITHUB_SHA ?? 'HEAD';

  const packages = readPublishablePackagesAt(repositoryRoot, commit);
  const publishedVersionsByName = Object.fromEntries(
    await Promise.all(packages.map(async ({ name }) => [name, await fetchPublishedVersions(name)])),
  );

  assertMainVersionsArePublished(packages, publishedVersionsByName);

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
