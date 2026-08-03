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

/**
 * 直近の experimental リリース地点を返す。
 *
 * changeset publish は publish 時に `@maronn-oidc/experimental@<version>` タグを打つので、
 * HEAD から辿れる最新のそのタグが「前回リリースした commit」になる。
 * タグが 1 つも無い（= まだ publish していない）場合は null を返す。
 */
export function findLastExperimentalReleaseTag(repositoryRoot) {
  try {
    // タグが 1 つも無いときは git が非 0 で終わるのが正常系なので、エラー出力は捨てる
    return git(['describe', '--tags', '--match', `${EXPERIMENTAL}@*`, '--abbrev=0', 'HEAD'], repositoryRoot, {
      quiet: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 前回リリース以降に変更された experimental のパスを集める。
 * 未リリースなら、追跡されている src 配下すべてを「未リリースの変更」として扱う。
 */
export function collectChangedPathsSinceLastRelease(repositoryRoot) {
  const tag = findLastExperimentalReleaseTag(repositoryRoot);

  const output = tag
    ? git(['diff', '--name-only', tag, 'HEAD', '--', SOURCE_PREFIX], repositoryRoot)
    : git(['ls-files', '--', SOURCE_PREFIX], repositoryRoot);

  return { base: tag ?? '（experimental のリリースタグなし: 全ソースを未リリース扱い）', paths: output.split('\n') };
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
