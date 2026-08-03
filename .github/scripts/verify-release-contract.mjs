/**
 * リリース時の「core と experimental の組み合わせ」契約を検証する。
 *
 * @maronn-oidc/experimental は core を peerDependencies で参照し、range は 0.x 系の間
 * 広く取っている（理由は RELEASE.md「バージョニング方針」）。range が広いぶん、
 * core だけが先に進むと「公開済みの古い experimental が、まだ組み合わせて試していない
 * 新しい core をそのまま受け入れる」状態になる。そこで core の minor / major リリース時は
 * experimental も同時にリリースすることを CI で強制する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = '@maronn-oidc/core';
const EXPERIMENTAL = '@maronn-oidc/experimental';
const BREAKING_BUMPS = new Set(['minor', 'major']);

/**
 * changeset の frontmatter から `パッケージ名 -> bump 種別` を読み出す。
 * 本文中に同じ形の行があっても拾わないよう、最初の `---` ブロックだけを見る。
 */
export function parseChangesetBumps(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};

  const bumps = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = line.match(/^\s*['"]?(@?[^'":]+)['"]?\s*:\s*['"]?(major|minor|patch)['"]?\s*$/);
    if (match) bumps[match[1]] = match[2];
  }
  return bumps;
}

export function assertCoreBreakingChangeReleasesExperimental(changesets) {
  const breaking = changesets.filter(({ bumps }) => BREAKING_BUMPS.has(bumps[CORE]));
  if (breaking.length === 0) return;

  const releasesExperimental = changesets.some(({ bumps }) => bumps[EXPERIMENTAL] !== undefined);
  if (releasesExperimental) return;

  const files = breaking.map(({ file }) => file).join(', ');
  throw new Error(
    `${CORE} を minor 以上で上げる changeset (${files}) がありますが、` +
      `${EXPERIMENTAL} の changeset がありません。` +
      'experimental は core を広い peer range で参照しており、公開済みの古い experimental が' +
      '新しい core をそのまま受け入れてしまうため、core の minor / major では' +
      'experimental も同時にリリースして最新 core との組み合わせを保証してください。',
  );
}

/**
 * experimental の bump は常に patch であることを強制する。
 *
 * experimental のリリースは `packages/experimental/src` の変更を検出して changeset を
 * 自動生成する運用（`.github/scripts/ensure-experimental-changeset.mjs`）にしており、
 * 「どんな変更でも patch を 1 つ上げるだけ」に固定することで、Version Packages PR の
 * マージ忘れで複数の変更がたまっても 1 回の patch に吸収されるようにしている。
 * 手書きの changeset が minor / major を指定するとこの前提が崩れるため CI で弾く。
 */
export function assertExperimentalReleasesAreAlwaysPatch(changesets) {
  const nonPatch = changesets.filter(
    ({ bumps }) => bumps[EXPERIMENTAL] !== undefined && bumps[EXPERIMENTAL] !== 'patch',
  );
  if (nonPatch.length === 0) return;

  const files = nonPatch.map(({ file, bumps }) => `${file} (${bumps[EXPERIMENTAL]})`).join(', ');
  throw new Error(
    `${EXPERIMENTAL} を patch 以外で上げる changeset (${files}) があります。` +
      'experimental のバージョンは変更内容に関わらず patch 固定です。' +
      'リリースは src の変更から changeset を自動生成する運用のため、' +
      'bump 種別を patch に直してください（RELEASE.md「experimental の自動 publish」）。',
  );
}

export function assertExperimentalCorePeerDependencyShape(packageJson) {
  if (packageJson.dependencies?.[CORE] !== undefined) {
    throw new Error(
      `${EXPERIMENTAL} は ${CORE} を dependencies に持ってはいけません。` +
        'core が二重にインストールされると instanceof 判定が静かに false になります。',
    );
  }

  if (packageJson.peerDependencies?.[CORE] === undefined) {
    throw new Error(`${EXPERIMENTAL} は ${CORE} を peerDependencies に宣言してください。`);
  }

  if (packageJson.devDependencies?.[CORE] !== 'workspace:*') {
    throw new Error(
      `${EXPERIMENTAL} は ${CORE} を devDependencies の workspace:* で参照してください。` +
        'ローカル開発とテストが registry の core を引いてしまいます。',
    );
  }
}

export function readChangesets(changesetDirectory) {
  return readdirSync(changesetDirectory)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .map((file) => ({
      file,
      bumps: parseChangesetBumps(readFileSync(join(changesetDirectory, file), 'utf8')),
    }));
}

function verifyReleaseContract() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

  const changesets = readChangesets(join(repositoryRoot, '.changeset'));

  assertCoreBreakingChangeReleasesExperimental(changesets);
  assertExperimentalReleasesAreAlwaysPatch(changesets);
  assertExperimentalCorePeerDependencyShape(
    JSON.parse(readFileSync(join(repositoryRoot, 'packages/experimental/package.json'), 'utf8')),
  );

  console.log(
    'Release contract verified: core / experimental peer dependency, release pairing and experimental patch-only bumps',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyReleaseContract();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
