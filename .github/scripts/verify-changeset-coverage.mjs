/**
 * publish 可能なパッケージの出荷物を変更した PR が、その PR 自身で changeset を
 * 追加しているかを検証する。
 *
 * 【なぜ必要か】
 * リリースは Changesets の二段階フロー（`.github/workflows/release.yml`）で動く。
 * 未消化の changeset があるときだけ「Version Packages」PR が作られ、その PR を
 * マージすると publish される。裏を返すと **changeset を書き忘れた変更は
 * Version Packages PR に現れず、publish されないまま main に埋もれる**。
 * CI は緑、PR もマージ済みなので、書き忘れに気づく手がかりがどこにもない。
 *
 * そこでこのスクリプトが「出荷物が変わったなら changeset がある」ことを PR 時点で
 * 強制し、packages/cli にオプション追加や実装修正が入った時点で
 * publish 導線（Version Packages PR）が必ず立ち上がる状態を保証する。
 *
 * 【リリース不要の変更をどう通すか】
 * `pnpm changeset --empty` で空の changeset を追加する。空 changeset は
 * `changeset version` がバージョンを上げずに消化するため、「リリース不要と判断した」
 * ことを diff に残したままチェックを通せる。判断がレビューに載るのが狙いなので、
 * ラベルや環境変数によるスキップ手段はあえて用意しない。
 *
 * 【対象の切り出し方】
 * - パッケージ: `packages` 配下の各 `package.json` のうち private でないもの（= npm に出る）
 * - 変更ファイル: 出荷物に入らないもの（テスト・CHANGELOG・vitest 設定）は除外する
 * - changeset: **この PR で追加された** `.changeset/*.md` だけを見る。
 *   main に溜まっている既存 changeset を数えると、前の PR の changeset が
 *   今回の変更の CHANGELOG 記載を肩代わりしてしまい、変更履歴が欠ける。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseChangesetBumps } from './verify-release-contract.mjs';

const PACKAGE_GLOB_ROOT = 'packages';

/** 出荷物（npm tarball）に入らず、publish を伴わない変更 */
const NON_SHIPPED_FILE_PATTERNS = [
  /(^|\/)__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)CHANGELOG\.md$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
];

export function selectPublishablePackages(entries) {
  return entries
    .filter(({ manifest }) => manifest.name !== undefined && manifest.private !== true)
    .map(({ directory, manifest }) => ({ name: manifest.name, directory }));
}

export function isReleaseRelevantPath(path) {
  return !NON_SHIPPED_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

export function findChangedPublishablePackages(changedFiles, packages) {
  const changed = new Set();

  for (const file of changedFiles) {
    if (!isReleaseRelevantPath(file)) continue;

    // `packages/cli-extra/...` が `packages/cli` に一致しないよう境界を `/` で判定する
    const owner = packages.find(({ directory }) => file.startsWith(`${directory}/`));
    if (owner) changed.add(owner.name);
  }

  return [...changed].sort();
}

export function assertChangesetCoversChangedPackages({ changedPackages, addedChangesets }) {
  if (changedPackages.length === 0) return;

  // 空 changeset =「リリース不要」と作者が明示した合図
  const hasEmptyChangeset = addedChangesets.some(({ bumps }) => Object.keys(bumps).length === 0);
  if (hasEmptyChangeset) return;

  const releasedPackages = new Set(addedChangesets.flatMap(({ bumps }) => Object.keys(bumps)));
  const missing = changedPackages.filter((name) => !releasedPackages.has(name));
  if (missing.length === 0) return;

  throw new Error(
    `次のパッケージの出荷物が変更されていますが、この PR に対応する changeset がありません: ${missing.join(', ')}\n` +
      'changeset が無い変更は Version Packages PR に現れず、publish されないまま main に埋もれます。\n' +
      '  - リリースする場合:   pnpm changeset を実行し、生成された .changeset/*.md をコミットしてください\n' +
      '  - リリース不要の場合: pnpm changeset --empty を実行し、生成された .changeset/*.md をコミットしてください',
  );
}

function readPublishablePackages(repositoryRoot) {
  const packagesRoot = join(repositoryRoot, PACKAGE_GLOB_ROOT);

  const entries = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      directory: `${PACKAGE_GLOB_ROOT}/${entry.name}`,
      manifest: JSON.parse(readFileSync(join(packagesRoot, entry.name, 'package.json'), 'utf8')),
    }));

  return selectPublishablePackages(entries);
}

function readAddedChangesets(repositoryRoot, addedChangesetPaths) {
  return addedChangesetPaths.map((file) => ({
    file,
    bumps: parseChangesetBumps(readFileSync(join(repositoryRoot, file), 'utf8')),
  }));
}

/** 改行区切りの環境変数を、空行を除いたパス配列にする */
function parsePathList(value) {
  return (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function verifyChangesetCoverage() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

  const packages = readPublishablePackages(repositoryRoot);
  const changedPackages = findChangedPublishablePackages(
    parsePathList(process.env.CHANGED_FILES),
    packages,
  );

  const addedChangesets = readAddedChangesets(
    repositoryRoot,
    parsePathList(process.env.ADDED_CHANGESETS).filter((file) => !file.endsWith('/README.md')),
  );

  assertChangesetCoversChangedPackages({ changedPackages, addedChangesets });

  console.log(
    changedPackages.length === 0
      ? 'Changeset coverage verified: no publishable package changed'
      : `Changeset coverage verified: ${changedPackages.join(', ')}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyChangesetCoverage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
