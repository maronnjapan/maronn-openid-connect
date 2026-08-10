/**
 * リポジトリを走査して、昇格レビューパケットの入力（model）を組み立てる層。
 *
 * ここに「この機能はリポジトリのどこに現れるか」の規約を集約する:
 *   - experimental 本体:    packages/experimental/src/<feature-id>/
 *   - CLI 統合:             packages/cli/src/ 内の言及ファイル
 *   - 生成コードへの寄与:   CLI generator をデフォルト構成 / --enable <feature-id> で
 *                           2 回実行した出力の差分
 *   - サンプル:             各 samples ディレクトリの package.json にある generate スクリプト
 *   - E2E:                  tests/e2e/ 内の言及ファイル
 *   - ドキュメント:         docs/library-document/ と packages/experimental/README.md
 *   - タスク文書:           tasks/experimental/(done/)?<feature-id>/
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import {
  countFeatureMentions,
  countLines,
  parseEnabledFeatures,
  parseOutputDir,
  parseSpecName,
} from './feature-scope.mjs';
import { classifyTrees, diffStats, renderUnifiedDiff } from './tree-diff.mjs';
import { groupFrameworksByDiff } from './packet.mjs';

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** repoRoot 配下の相対ディレクトリを再帰的に歩き、対象拡張子のファイルを列挙する。 */
function walkFiles(repoRoot, relDir, extensions) {
  const absDir = join(repoRoot, relDir);
  if (!existsSync(absDir)) return [];

  const results = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const relPath = posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(repoRoot, relPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(relPath);
    }
  }
  return results.sort();
}

function mentionEntries(repoRoot, relPaths, featureId) {
  const entries = [];
  for (const relPath of relPaths) {
    const mentions = countFeatureMentions(readFileSync(join(repoRoot, relPath), 'utf8'), featureId);
    if (mentions > 0) entries.push({ path: relPath, mentions });
  }
  return entries.sort(byPath);
}

/**
 * 機能のタスク文書ディレクトリを探す。
 * 仕様検討中（tasks/experimental/<id>）を優先し、次に実装済み（done/<id>）を見る。
 */
export function findFeatureTaskDir(repoRoot, featureId) {
  for (const candidate of [
    posix.join('tasks/experimental', featureId),
    posix.join('tasks/experimental/done', featureId),
  ]) {
    if (existsSync(join(repoRoot, candidate))) return candidate;
  }
  return null;
}

/** packages/experimental/src/<id> の実装ファイルとテストファイルを行数付きで列挙する。 */
export function listExperimentalSrc(repoRoot, featureId) {
  const dir = posix.join('packages/experimental/src', featureId);
  const files = walkFiles(repoRoot, dir, ['.ts']).map((path) => ({
    path,
    lines: countLines(readFileSync(join(repoRoot, path), 'utf8')),
  }));
  return {
    dir,
    implFiles: files.filter((f) => !f.path.includes('.test.')),
    testFiles: files.filter((f) => f.path.includes('.test.')),
  };
}

/** packages/cli/src 内で機能に言及するファイルを列挙する。 */
export function scanCliReferences(repoRoot, featureId) {
  return mentionEntries(repoRoot, walkFiles(repoRoot, 'packages/cli/src', ['.ts']), featureId);
}

/** tests/e2e 内で機能に言及するファイルを列挙する。 */
export function scanE2e(repoRoot, featureId) {
  return mentionEntries(
    repoRoot,
    walkFiles(repoRoot, 'tests/e2e', ['.ts', '.tsx', '.mjs', '.js']),
    featureId,
  );
}

/** samples/* の generate スクリプトを読み、機能の有効化状況を列挙する。 */
export function scanSamples(repoRoot, featureId) {
  const samplesDir = join(repoRoot, 'samples');
  if (!existsSync(samplesDir)) return [];

  const samples = [];
  for (const entry of readdirSync(samplesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(samplesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const generateScript = manifest.scripts?.generate;
    const enabledFeatures = parseEnabledFeatures(generateScript);
    const outputDir = parseOutputDir(generateScript);
    samples.push({
      name: entry.name,
      enabledFeatures,
      usesFeature: enabledFeatures.includes(featureId),
      generatedDir: outputDir ? posix.join('samples', entry.name, outputDir) : null,
    });
  }
  return samples.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 利用者向けドキュメントと experimental README のうち、機能に言及するものを列挙する。 */
export function scanDocs(repoRoot, featureId) {
  const entries = mentionEntries(
    repoRoot,
    walkFiles(repoRoot, 'docs/library-document/src/content/docs', ['.md', '.mdx']),
    featureId,
  );
  const readmePath = 'packages/experimental/README.md';
  if (existsSync(join(repoRoot, readmePath))) {
    entries.push(...mentionEntries(repoRoot, [readmePath], featureId));
  }
  return entries;
}

/** タスク文書ディレクトリ直下のファイルを、レビューで読む順序で列挙する。 */
export function listTaskDocs(repoRoot, taskDirRepoPath) {
  const preferredOrder = [
    'specification.md',
    'understanding-guide.md',
    'sources.md',
    'review-log.md',
    'state.yaml',
  ];
  const absDir = join(repoRoot, taskDirRepoPath);
  if (!existsSync(absDir)) return [];

  const names = readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const ordered = [
    ...preferredOrder.filter((name) => names.includes(name)),
    ...names.filter((name) => !preferredOrder.includes(name)).sort(),
  ];
  return ordered.map((name) => ({ path: posix.join(taskDirRepoPath, name) }));
}

/**
 * パケット描画に必要な model を組み立てる。
 *
 * generator には packages/cli/dist の { generate, resolveFeatures,
 * getAvailableFrameworks } を渡す（テストでは決定的なフェイクを注入できる）。
 */
export function buildPacketModel({ repoRoot, featureId, generator }) {
  const taskDir = findFeatureTaskDir(repoRoot, featureId);
  if (taskDir === null) {
    throw new Error(
      `機能 "${featureId}" のタスク文書ディレクトリが見つかりません。` +
        `先に tasks/experimental/${featureId}/ （または done/${featureId}/）を用意してください。`,
    );
  }

  const packetDirRepoPath = posix.join(taskDir, 'promotion-review');
  const baselineLabel = 'default-op';
  const enabledLabel = `with-${featureId}`;

  const baselineFeatures = generator.resolveFeatures({});
  const enabledFeatures = generator.resolveFeatures({ enable: [featureId] });

  const frameworkDiffs = generator.getAvailableFrameworks().map((framework) => {
    const baseline = generator.generate({
      framework,
      outputDir: '/review',
      features: { ...baselineFeatures },
    }).files;
    const enabled = generator.generate({
      framework,
      outputDir: '/review',
      features: { ...enabledFeatures },
    }).files;
    const patch = renderUnifiedDiff(baseline, enabled, baselineLabel, enabledLabel);
    return {
      framework,
      patch,
      classification: classifyTrees(baseline, enabled),
      stats: diffStats(patch),
    };
  });

  const specPath = join(repoRoot, taskDir, 'specification.md');
  const specName = existsSync(specPath) ? parseSpecName(readFileSync(specPath, 'utf8')) : null;

  return {
    featureId,
    specName,
    packetDirRepoPath,
    relPrefix: posix.relative(packetDirRepoPath, ''),
    experimentalSrc: listExperimentalSrc(repoRoot, featureId),
    cliReferences: scanCliReferences(repoRoot, featureId),
    generated: {
      baselineLabel,
      enabledLabel,
      groups: groupFrameworksByDiff(frameworkDiffs),
    },
    samples: scanSamples(repoRoot, featureId),
    e2e: scanE2e(repoRoot, featureId),
    docs: scanDocs(repoRoot, featureId),
    taskDocs: listTaskDocs(repoRoot, taskDir),
  };
}
