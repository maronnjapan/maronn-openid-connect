/**
 * `@maronn-oidc/experimental` の publish 用 changeset を自動生成する。
 *
 * experimental は新しい仕様を先行実装する場所なので、`packages/experimental/src` に
 * 機能追加や実装修正が入ったら「そのまま publish できる状態」にしておきたい。
 * 一方で変更のたびに手で `pnpm changeset` を書かせると、書き忘れがそのまま
 * 「publish されない」に直結する。そこで release.yml から本スクリプトを実行し、
 * 前回リリース以降に `packages/experimental/src` が変わっていれば
 * patch の changeset を自動で置く（詳細は RELEASE.md「experimental の自動 publish」）。
 *
 * 設計上の約束:
 *   - bump は常に patch 固定。experimental のバージョンは 0.0.x を 1 つずつ進めるだけにする
 *     （手書きの changeset が minor / major を指定していないかは verify-release-contract.mjs が検査する）。
 *   - 生成する changeset は常に 1 本（`auto-experimental-patch.md`）で、実行のたびに
 *     未リリースの変更一覧で上書きする。Version Packages PR のマージを忘れて複数機能が
 *     たまっても、changeset は 1 本のままなのでまとめて patch 1 回に吸収される。
 *     手書きの experimental changeset が残っているときは、そちらを尊重して何もしない。
 *   - テストコード（*.test.ts / *.spec.ts）の変更は publish 対象にしない。
 *     tsconfig の exclude と同じで dist に出ないため、利用者に届く成果物が変わらない。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readChangesets } from './verify-release-contract.mjs';

const EXPERIMENTAL = '@maronn-oidc/experimental';
const SOURCE_PREFIX = 'packages/experimental/src/';
const MANIFEST_PATH = 'packages/experimental/package.json';
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?tsx?$/;

/** 自動生成する changeset のファイル名。毎回同じ名前にして、実行を繰り返しても 1 本に保つ。 */
export const AUTO_CHANGESET_FILENAME = 'auto-experimental-patch.md';

/**
 * git の出力（1 行 1 パス）から、publish 対象になる experimental のソース変更だけを取り出す。
 */
export function selectExperimentalSourceChanges(changedPaths) {
  return changedPaths
    .map((path) => path.trim())
    .filter((path) => path.startsWith(SOURCE_PREFIX))
    .filter((path) => !TEST_FILE_PATTERN.test(path));
}

/**
 * 自動生成ではない（人が書いた）experimental の changeset があるかを返す。
 *
 * 自動生成した changeset は毎回書き直して変更一覧を最新にするが、手書きの changeset は
 * リリースノートとして人の意図が入っているので上書きも二重追加もしない。
 * どちらの場合も changeset は 1 本にとどまるので bump は patch 1 回のままになる。
 */
export function hasManualExperimentalChangeset(changesets) {
  return changesets.some(({ file, bumps }) => bumps[EXPERIMENTAL] !== undefined && file !== AUTO_CHANGESET_FILENAME);
}

export function buildExperimentalPatchChangeset(sourcePaths) {
  const sorted = [...sourcePaths].sort();

  return [
    '---',
    `"${EXPERIMENTAL}": patch`,
    '---',
    '',
    '`packages/experimental/src` の変更をリリースする。experimental のバージョンは変更内容に関わらず patch を 1 つ上げるだけに固定しており、未リリースの変更が複数たまっている場合も 1 回の patch に吸収する。',
    '',
    'このリリースに含まれる変更:',
    '',
    ...sorted.map((path) => `- ${path}`),
    '',
  ].join('\n');
}

/**
 * 「changeset を置くべきか」を決める。git / ファイルシステムには触らない。
 */
export function decideExperimentalChangeset({ changedPaths, changesets }) {
  const sourceChanges = selectExperimentalSourceChanges(changedPaths);

  if (sourceChanges.length === 0) {
    return {
      shouldCreate: false,
      reason: '未リリースの packages/experimental/src の変更がないため changeset を作成しない',
    };
  }

  if (hasManualExperimentalChangeset(changesets)) {
    return {
      shouldCreate: false,
      reason: '手書きの experimental changeset が未リリースで残っているため changeset を作成しない',
    };
  }

  return {
    shouldCreate: true,
    reason:
      `未リリースの packages/experimental/src の変更が ${sourceChanges.length} 件あるため、` +
      `patch の changeset を .changeset/${AUTO_CHANGESET_FILENAME} に書き出す`,
    content: buildExperimentalPatchChangeset(sourceChanges),
  };
}

function git(args, repositoryRoot, { quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  });
}

/** package.json の中身から version を読む。読めない・持っていない場合は null。 */
export function readVersionFromManifest(content) {
  try {
    const version = JSON.parse(content).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * 「experimental の version を確定したコミット」を、新しい順の候補から 1 つ選ぶ。
 *
 * version が親のどれとも違うコミットだけを bump と見なす。Version Packages PR の
 * マージコミットはリリースブランチ側の親から version を引き継ぐだけなので除外され、
 * `changeset version` が実際に version を書き換えたコミットが選ばれる。
 */
export function selectLastVersionBump(candidates) {
  const bump = candidates.find(
    ({ version, parentVersions }) =>
      version !== null && parentVersions.every((parentVersion) => parentVersion !== version),
  );

  return bump ? { commit: bump.commit, version: bump.version } : null;
}

function readManifestVersionAt(repositoryRoot, commit) {
  try {
    // そのコミットに package.json が無いのは正常系（package 追加前・削除後）なのでエラー出力は捨てる
    return readVersionFromManifest(git(['show', `${commit}:${MANIFEST_PATH}`], repositoryRoot, { quiet: true }));
  } catch {
    return null;
  }
}

function listParents(repositoryRoot, commit) {
  return git(['rev-list', '--parents', '-n', '1', commit], repositoryRoot).trim().split(/\s+/).slice(1);
}

/**
 * 直近の experimental リリース基準点を返す。
 *
 * 基準は「`packages/experimental/package.json` の version を最後に確定したコミット」。
 * publish 時のタグを基準にしていた頃は、タグが publish でしか生まれないのに
 * publish はこの判定の結果でしか起きない、という循環で publish に到達できなかった
 * （詳細は RELEASE.md「なぜ version 確定コミットを基準にするのか」）。
 * version は Version Packages PR がマージされた時点で確定するので、
 * マージ直後の main では「未リリースの変更ゼロ」と判定できる。
 */
export function findLastExperimentalVersionBump(repositoryRoot) {
  const commits = git(['log', '--format=%H', 'HEAD', '--', MANIFEST_PATH], repositoryRoot)
    .split('\n')
    .map((commit) => commit.trim())
    .filter((commit) => commit.length > 0);

  return selectLastVersionBump(
    commits.map((commit) => ({
      commit,
      version: readManifestVersionAt(repositoryRoot, commit),
      parentVersions: listParents(repositoryRoot, commit).map((parent) =>
        readManifestVersionAt(repositoryRoot, parent),
      ),
    })),
  );
}

/**
 * 現在の version に載っていない experimental のパスを集める。
 * version を確定したコミットが履歴に無いなら、追跡されている src 配下すべてを未リリース扱いにする。
 */
export function collectChangedPathsSinceLastRelease(repositoryRoot) {
  const bump = findLastExperimentalVersionBump(repositoryRoot);

  const output = bump
    ? git(['diff', '--name-only', bump.commit, 'HEAD', '--', SOURCE_PREFIX], repositoryRoot)
    : git(['ls-files', '--', SOURCE_PREFIX], repositoryRoot);

  return {
    base: bump
      ? `${bump.commit} (version ${bump.version})`
      : '（experimental の version を確定したコミットなし: 全ソースを未リリース扱い）',
    paths: output.split('\n'),
  };
}

function ensureExperimentalChangeset() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const changesetDirectory = join(repositoryRoot, '.changeset');

  const { base, paths } = collectChangedPathsSinceLastRelease(repositoryRoot);
  const decision = decideExperimentalChangeset({
    changedPaths: paths,
    changesets: readChangesets(changesetDirectory),
  });

  console.log(`experimental の比較基準: ${base}`);
  console.log(decision.reason);

  if (!decision.shouldCreate) return;

  const changesetPath = join(changesetDirectory, AUTO_CHANGESET_FILENAME);
  writeFileSync(changesetPath, decision.content, 'utf8');
  console.log(`.changeset/${AUTO_CHANGESET_FILENAME} を作成した`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureExperimentalChangeset();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
