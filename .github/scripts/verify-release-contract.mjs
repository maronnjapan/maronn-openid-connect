/**
 * リリース時の「core と experimental の組み合わせ」契約を検証する。
 *
 * @maronn-openid-connect/experimental は core を peerDependencies で参照し、range は 0.x 系の間
 * 広く取っている（理由は RELEASE.md「バージョニング方針」）。range が広いぶん、
 * core だけが先に進むと「公開済みの古い experimental が、まだ組み合わせて試していない
 * 新しい core をそのまま受け入れる」状態になる。そこで core の minor / major リリース時は
 * experimental も同時にリリースすることを CI で強制する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = '@maronn-openid-connect/core';
const EXPERIMENTAL = '@maronn-openid-connect/experimental';
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

/**
 * peer range `>=X.Y.Z <A.B.C` の下限 `X.Y.Z` を読み出す。
 * caret やワイルドカードなど下限を一意に決められない書き方は null を返し、
 * 呼び出し側で「読み取れない range」として弾く。
 */
export function parseMinimumCoreVersion(range) {
  const match = range.match(/(?:^|\s)>=\s*(\d+\.\d+\.\d+)(?:\s|$)/);
  return match?.[1] ?? null;
}

/** semver の bump を 1 つ適用する。bump が未指定ならバージョンは据え置く。 */
export function computeNextVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);

  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return version;
}

/**
 * 未消化の changeset を適用したあとの core のバージョン（= 次に publish される core）を求める。
 * 同じ package を上げる changeset が複数あるとき、Changesets は最も大きい bump を採用する。
 */
export function resolveNextCoreVersion(currentCoreVersion, changesets) {
  const bumps = changesets.map(({ bumps: b }) => b[CORE]).filter((bump) => bump !== undefined);

  const largest = ['major', 'minor', 'patch'].find((bump) => bumps.includes(bump));
  return computeNextVersion(currentCoreVersion, largest);
}

/** 版を数値として比較する（"0.9.0" < "0.10.0" を文字列比較で誤らないため）。 */
function compareVersions(left, right) {
  const l = left.split('.').map(Number);
  const r = right.split('.').map(Number);

  for (let i = 0; i < 3; i += 1) {
    if (l[i] !== r[i]) return l[i] - r[i];
  }
  return 0;
}

/**
 * experimental の peer range の下限が「次に publish される core」以上であることを強制する。
 *
 * experimental はモノレポ内の core（= 次に publish される core）だけを相手にビルド・テスト
 * されるので、それより古い core を下限に据えるのは「試していない組み合わせ」を許可宣言する
 * ことに等しい。実際 experimental 0.0.1 は、core の step 関数
 * （extractClientCredentials / resolveAuthenticatedTokenClient / validateClientAuthMethod /
 * verifyClientSecret）を import しながら下限を `>=0.0.1` のままにして publish され、
 * それらを export していない core 0.0.1 と組み合わさって
 * esbuild の "No matching export" で落ちる状態になった。
 *
 * RELEASE.md「peer range は『下限』を宣言する」の手運用をここで機械化する。
 */
export function assertExperimentalCorePeerRangeCoversNextCore(packageJson, nextCoreVersion) {
  const range = packageJson.peerDependencies?.[CORE];
  const minimum = parseMinimumCoreVersion(range);

  if (minimum === null) {
    throw new Error(
      `${EXPERIMENTAL} の ${CORE} peer range "${range}" から下限を読み取れません。` +
        '`>=X.Y.Z <A.B.C` の形式で宣言してください（caret は Changesets の major 昇格を誘発するため使わない）。',
    );
  }

  if (compareVersions(minimum, nextCoreVersion) < 0) {
    throw new Error(
      `${EXPERIMENTAL} の ${CORE} peer range "${range}" は core ${nextCoreVersion} より古い ` +
        `${minimum} を下限にしています。experimental はモノレポ内の core だけを相手に` +
        'ビルド・テストされるため、それより古い core を許可すると、experimental が使う API を' +
        'まだ export していない core と組み合わさって "No matching export" で落ちます。' +
        `下限を ">=${nextCoreVersion}" へ上げてください（RELEASE.md「peer range は『下限』を宣言する」）。`,
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
  const experimentalPackageJson = JSON.parse(
    readFileSync(join(repositoryRoot, 'packages/experimental/package.json'), 'utf8'),
  );
  const corePackageJson = JSON.parse(
    readFileSync(join(repositoryRoot, 'packages/core/package.json'), 'utf8'),
  );

  assertCoreBreakingChangeReleasesExperimental(changesets);
  assertExperimentalReleasesAreAlwaysPatch(changesets);
  assertExperimentalCorePeerDependencyShape(experimentalPackageJson);
  assertExperimentalCorePeerRangeCoversNextCore(
    experimentalPackageJson,
    resolveNextCoreVersion(corePackageJson.version, changesets),
  );

  console.log(
    'Release contract verified: core / experimental peer dependency, peer range lower bound, release pairing and experimental patch-only bumps',
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
