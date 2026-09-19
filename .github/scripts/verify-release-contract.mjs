/**
 * リリース時の「core と、core を peer 参照するパッケージの組み合わせ」契約を検証する。
 *
 * @maronn-openid-connect/experimental と @maronn-openid-connect/google-login は core を
 * peerDependencies で参照し、range は 0.x 系の間広く取っている（理由は RELEASE.md
 * 「バージョニング方針」）。range が広いぶん、core だけが先に進むと「公開済みの古い
 * 拡張パッケージが、まだ組み合わせて試していない新しい core をそのまま受け入れる」
 * 状態になる。そこで core の minor / major リリース時は、core を peer 参照する
 * パッケージも同時にリリースすることを CI で強制する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = '@maronn-openid-connect/core';
const EXPERIMENTAL = '@maronn-openid-connect/experimental';
const GOOGLE_LOGIN = '@maronn-openid-connect/google-login';
const BREAKING_BUMPS = new Set(['minor', 'major']);

/**
 * core を peerDependencies で参照するパッケージ。
 *
 * これらはモノレポ内の core（= 次に publish される core）だけを相手にビルド・テストされる
 * ため、peer range の下限と core の minor / major との同時リリースを CI で強制する対象になる。
 * core を peer 参照するパッケージを増やしたらここに足す。
 */
export const CORE_DEPENDENT_PACKAGES = [
  { name: EXPERIMENTAL, manifestPath: 'packages/experimental/package.json' },
  { name: GOOGLE_LOGIN, manifestPath: 'packages/google-login/package.json' },
];

const CORE_DEPENDENT_NAMES = CORE_DEPENDENT_PACKAGES.map(({ name }) => name);

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

/**
 * core を minor / major で上げる changeset があるとき、core を peer 参照するパッケージ
 * すべてに changeset があることを強制する。
 *
 * @param changesets 未消化の changeset（`readChangesets` の結果）
 * @param dependents 検査対象のパッケージ名。既定は {@link CORE_DEPENDENT_PACKAGES}
 */
export function assertCoreBreakingChangeReleasesCoreDependents(
  changesets,
  dependents = CORE_DEPENDENT_NAMES,
) {
  const breaking = changesets.filter(({ bumps }) => BREAKING_BUMPS.has(bumps[CORE]));
  if (breaking.length === 0) return;

  const missing = dependents.filter(
    (name) => !changesets.some(({ bumps }) => bumps[name] !== undefined),
  );
  if (missing.length === 0) return;

  const files = breaking.map(({ file }) => file).join(', ');
  throw new Error(
    `${CORE} を minor 以上で上げる changeset (${files}) がありますが、` +
      `${missing.join(', ')} の changeset がありません。` +
      'これらは core を広い peer range で参照しており、公開済みの古いパッケージが' +
      '新しい core をそのまま受け入れてしまうため、core の minor / major では' +
      '同時にリリースして最新 core との組み合わせを保証してください。',
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
 *
 * google-login はこの対象外。手書きの changeset で semver（0.x）を進める。
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

/**
 * private パッケージを Changesets のバージョニング対象から外していることを強制する。
 *
 * `samples/*`・`tests/*`・`docs/*` は npm へ publish しない検証用のワークスペースだが、
 * Changesets は既定（`privatePackages.version: true`）だと private パッケージも
 * バージョニングの対象にする。samples は core / experimental を `workspace:*` で参照して
 * いるため、`updateInternalDependencies` の連鎖で毎回 patch が積まれ、
 * 「Version Packages」PR の Releases 一覧に
 * `@maronn-openid-connect/sample-hono-cloudflare@0.0.7` のような、**利用者が npm から
 * 取得できないパッケージのバージョンアップ**が並ぶ。リリース PR は「今回 npm に出るもの」を
 * 読む場所なので、出ないものが混ざると publish 対象の判別ができなくなる。
 *
 * publish 対象かどうかは `package.json` の `private` が唯一の情報源なので、
 * samples を名前で列挙する（`ignore`）のではなく private 全体を対象外にする。
 * 新しい sample やテスト用ワークスペースを足しても設定を触らなくて済む。
 */
export function assertPrivatePackagesAreNotVersioned(changesetConfig) {
  // `privatePackages: false` は `{ version: false, tag: false }` の省略形（@changesets/config）
  if (changesetConfig.privatePackages === false) return;
  if (changesetConfig.privatePackages?.version === false) return;

  throw new Error(
    '.changeset/config.json で private パッケージがバージョニング対象のままです。' +
      '`privatePackages.version` を false にしてください。' +
      'true（既定値）のままだと samples / tests / docs も Changesets のバージョン上げ対象になり、' +
      'npm へ publish しないパッケージのバージョンアップが「Version Packages」PR に並んで、' +
      '今回 publish されるパッケージを読み取れなくなります。',
  );
}

function packageLabel(packageJson) {
  return packageJson.name ?? '(name 未設定のパッケージ)';
}

/**
 * core を peer 参照するパッケージの依存宣言の形を強制する。
 *
 * - core を dependencies に持たない（二重インストールで instanceof が静かに false になる）
 * - core を peerDependencies に宣言する
 * - ローカル開発とテスト用に devDependencies の workspace:* で参照する
 */
export function assertCorePeerDependencyShape(packageJson) {
  const name = packageLabel(packageJson);

  if (packageJson.dependencies?.[CORE] !== undefined) {
    throw new Error(
      `${name} は ${CORE} を dependencies に持ってはいけません。` +
        'core が二重にインストールされると instanceof 判定が静かに false になります。',
    );
  }

  if (packageJson.peerDependencies?.[CORE] === undefined) {
    throw new Error(`${name} は ${CORE} を peerDependencies に宣言してください。`);
  }

  if (packageJson.devDependencies?.[CORE] !== 'workspace:*') {
    throw new Error(
      `${name} は ${CORE} を devDependencies の workspace:* で参照してください。` +
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
 * core を peer 参照するパッケージの peer range の下限が「次に publish される core」以上で
 * あることを強制する。
 *
 * これらのパッケージはモノレポ内の core（= 次に publish される core）だけを相手にビルド・
 * テストされるので、それより古い core を下限に据えるのは「試していない組み合わせ」を許可
 * 宣言することに等しい。実際 experimental 0.0.1 は、core の step 関数
 * （extractClientCredentials / resolveAuthenticatedTokenClient / validateClientAuthMethod /
 * verifyClientSecret）を import しながら下限を `>=0.0.1` のままにして publish され、
 * それらを export していない core 0.0.1 と組み合わさって
 * esbuild の "No matching export" で落ちる状態になった。
 *
 * RELEASE.md「peer range は『下限』を宣言する」の手運用をここで機械化する。
 */
export function assertCorePeerRangeCoversNextCore(packageJson, nextCoreVersion) {
  const name = packageLabel(packageJson);
  const range = packageJson.peerDependencies?.[CORE];
  const minimum = parseMinimumCoreVersion(range);

  if (minimum === null) {
    throw new Error(
      `${name} の ${CORE} peer range "${range}" から下限を読み取れません。` +
        '`>=X.Y.Z <A.B.C` の形式で宣言してください（caret は Changesets の major 昇格を誘発するため使わない）。',
    );
  }

  if (compareVersions(minimum, nextCoreVersion) < 0) {
    throw new Error(
      `${name} の ${CORE} peer range "${range}" は core ${nextCoreVersion} より古い ` +
        `${minimum} を下限にしています。${name} はモノレポ内の core だけを相手に` +
        'ビルド・テストされるため、それより古い core を許可すると、このパッケージが使う API を' +
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
  const changesetConfig = JSON.parse(
    readFileSync(join(repositoryRoot, '.changeset/config.json'), 'utf8'),
  );
  const corePackageJson = JSON.parse(
    readFileSync(join(repositoryRoot, 'packages/core/package.json'), 'utf8'),
  );
  const nextCoreVersion = resolveNextCoreVersion(corePackageJson.version, changesets);

  assertCoreBreakingChangeReleasesCoreDependents(changesets);
  assertExperimentalReleasesAreAlwaysPatch(changesets);
  assertPrivatePackagesAreNotVersioned(changesetConfig);

  for (const { manifestPath } of CORE_DEPENDENT_PACKAGES) {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, manifestPath), 'utf8'));
    assertCorePeerDependencyShape(packageJson);
    assertCorePeerRangeCoversNextCore(packageJson, nextCoreVersion);
  }

  console.log(
    `Release contract verified: core peer dependency shape and peer range lower bound for ${CORE_DEPENDENT_NAMES.join(', ')}, ` +
      'release pairing on core minor / major, experimental patch-only bumps and private packages excluded from versioning',
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
