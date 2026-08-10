#!/usr/bin/env node
/**
 * Experimental 機能の昇格レビューパケットを生成・検証する CLI。
 *
 *   node scripts/experimental-review/cli.mjs <feature-id>            パケットを(再)生成
 *   node scripts/experimental-review/cli.mjs <feature-id> --check    パケットが実装と一致するか検証
 *   node scripts/experimental-review/cli.mjs --all [--check]         実装済み experimental 機能すべて
 *   node scripts/experimental-review/cli.mjs status                  機能ごとの状態を一覧表示
 *
 * このツールは判断をしない。判断（Go / No-Go）は人間がパケット内の
 * decision.md に記録する。ツールが所有するのはパケットの decision.md 以外の
 * ファイルだけで、decision.md は「無ければテンプレートを置く」以外に触らない。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDecisionTemplate, parseDecision } from './lib/decision.mjs';
import { buildPacketFiles } from './lib/packet.mjs';
import { buildPacketModel, findFeatureTaskDir } from './lib/repo.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** generator（packages/cli/dist）は常に本リポジトリのものを使う。 */
const toolRepoRoot = resolve(scriptDir, '../..');

const USAGE = `使い方:
  pnpm review:experimental <feature-id>            パケットを(再)生成
  pnpm review:experimental <feature-id> --check    パケットが実装と一致するか検証
  pnpm review:experimental --all [--check]         実装済み experimental 機能すべて
  pnpm review:experimental status                  機能ごとの状態を一覧表示`;

/** argv（node とスクリプトパスを除く）を解釈する。不正な入力は Error を投げる。 */
export function parseCliArgs(argv) {
  const result = { command: 'generate', features: [], repoRoot: null };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      // `pnpm run <script> -- --check` 形式でも動くよう、区切りは読み飛ばす。
      continue;
    }
    if (arg === '--check') {
      result.command = 'check';
    } else if (arg === '--all') {
      if (positional.length > 0) throw new Error(`--all と機能名は同時に指定できません。\n${USAGE}`);
      result.features = 'all';
    } else if (arg === '--repo-root') {
      i += 1;
      if (argv[i] === undefined) throw new Error(`--repo-root には値が必要です。\n${USAGE}`);
      result.repoRoot = argv[i];
    } else if (arg.startsWith('--')) {
      throw new Error(`不明なオプション: ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional[0] === 'status') {
    if (positional.length > 1 || result.command === 'check' || result.features === 'all') {
      throw new Error(`status は単独で指定してください。\n${USAGE}`);
    }
    return { command: 'status', features: 'all', repoRoot: result.repoRoot };
  }

  if (result.features === 'all') {
    return result;
  }
  if (positional.length === 0) {
    throw new Error(`機能名か --all を指定してください。\n${USAGE}`);
  }
  result.features = positional;
  return result;
}

async function loadGenerator() {
  const distDir = join(toolRepoRoot, 'packages/cli/dist');
  if (!existsSync(join(distDir, 'generator.js'))) {
    throw new Error(
      'packages/cli/dist が見つかりません。先に `pnpm --filter @maronn-openid-connect/cli build` を実行してください。',
    );
  }
  const generatorModule = await import(join(distDir, 'generator.js'));
  const featuresModule = await import(join(distDir, 'features.js'));
  return {
    generate: generatorModule.generate,
    getAvailableFrameworks: generatorModule.getAvailableFrameworks,
    resolveFeatures: featuresModule.resolveFeatures,
    experimentalFeatures: [...featuresModule.EXPERIMENTAL_FEATURES],
  };
}

/** ディレクトリ配下の全ファイルを、posix 相対パスのソート済み配列で返す。 */
function walkAllFiles(absDir, relDir = '') {
  if (!existsSync(absDir)) return [];
  const results = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relDir === '' ? entry.name : posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkAllFiles(join(absDir, entry.name), relPath));
    } else {
      results.push(relPath);
    }
  }
  return results.sort();
}

function buildExpected(repoRoot, generator, featureId) {
  const model = buildPacketModel({ repoRoot, featureId, generator });
  return { model, files: buildPacketFiles(model) };
}

function removeEmptyDirs(absDir) {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(join(absDir, entry.name));
  }
  if (readdirSync(absDir).length === 0) rmdirSync(absDir);
}

function runGenerate(repoRoot, generator, featureId) {
  const { model, files } = buildExpected(repoRoot, generator, featureId);
  const packetAbs = join(repoRoot, model.packetDirRepoPath);
  const expectedPaths = new Set(files.map((f) => f.path));

  // ツール所有ファイル（decision.md 以外）のうち、今回生成されないものは消す。
  for (const relPath of walkAllFiles(packetAbs)) {
    if (relPath === 'decision.md') continue;
    if (!expectedPaths.has(relPath)) rmSync(join(packetAbs, relPath));
  }
  for (const entry of existsSync(packetAbs)
    ? readdirSync(packetAbs, { withFileTypes: true })
    : []) {
    if (entry.isDirectory()) removeEmptyDirs(join(packetAbs, entry.name));
  }

  for (const file of files) {
    const target = join(packetAbs, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  const decisionPath = join(packetAbs, 'decision.md');
  const decisionCreated = !existsSync(decisionPath);
  if (decisionCreated) {
    writeFileSync(decisionPath, renderDecisionTemplate(featureId));
  }

  console.log(`[${featureId}] レビューパケットを生成しました: ${model.packetDirRepoPath}`);
  console.log(`  - README.md（レビュー対象の地図と推奨手順）`);
  console.log(`  - generated-code/（生成コード差分 ${model.generated.groups.length} グループ）`);
  console.log(
    decisionCreated
      ? '  - decision.md（判断記録テンプレートを新規作成）'
      : '  - decision.md（既存の判断記録には触れていません）',
  );
  console.log('次: README.md から読み始め、判断は decision.md に記録してください。');
}

function runCheck(repoRoot, generator, featureId) {
  const { model, files } = buildExpected(repoRoot, generator, featureId);
  const packetAbs = join(repoRoot, model.packetDirRepoPath);

  if (!existsSync(packetAbs)) {
    console.log(
      `${featureId}: パケットが未生成です。\`pnpm review:experimental ${featureId}\` で生成してください。`,
    );
    return false;
  }

  const actualPaths = walkAllFiles(packetAbs).filter((p) => p !== 'decision.md');
  const expectedByPath = new Map(files.map((f) => [f.path, f.content]));

  const missing = [];
  const different = [];
  for (const [path, content] of expectedByPath) {
    const absPath = join(packetAbs, path);
    if (!existsSync(absPath)) missing.push(path);
    else if (readFileSync(absPath, 'utf8') !== content) different.push(path);
  }
  const extra = actualPaths.filter((p) => !expectedByPath.has(p));

  if (missing.length === 0 && different.length === 0 && extra.length === 0) {
    console.log(`${featureId}: パケットは実装と一致しています`);
    return true;
  }

  console.log(`${featureId}: パケットが実装と一致しません（パケット生成後に実装が変わった可能性）`);
  for (const path of missing) console.log(`  不足: ${path}`);
  for (const path of different) console.log(`  内容差分: ${path}`);
  for (const path of extra) console.log(`  余分: ${path}`);
  console.log(
    `  \`pnpm review:experimental ${featureId}\` で再生成し、git diff で変化を確認してください。`,
  );
  return false;
}

function runStatus(repoRoot, generator) {
  console.log('experimental 機能の昇格レビュー状況:');
  for (const featureId of generator.experimentalFeatures) {
    const taskDir = findFeatureTaskDir(repoRoot, featureId);
    if (taskDir === null) {
      console.log(`${featureId} | パケット: なし（タスク文書なし） | 判断: - | 実装との一致: -`);
      continue;
    }

    const packetAbs = join(repoRoot, taskDir, 'promotion-review');
    if (!existsSync(packetAbs)) {
      console.log(`${featureId} | パケット: なし | 判断: - | 実装との一致: -`);
      continue;
    }

    const decisionPath = join(packetAbs, 'decision.md');
    let decisionLabel = '未作成';
    if (existsSync(decisionPath)) {
      const parsed = parseDecision(readFileSync(decisionPath, 'utf8'));
      decisionLabel = parsed.decision ?? '不明（decision.md を解釈できません）';
      if (parsed.decision !== null && parsed.decidedAt !== null) {
        decisionLabel = `${parsed.decision}（${parsed.decidedAt}）`;
      }
    }

    const { files } = buildExpected(repoRoot, generator, featureId);
    const expectedByPath = new Map(files.map((f) => [f.path, f.content]));
    const actualPaths = walkAllFiles(packetAbs).filter((p) => p !== 'decision.md');
    const clean =
      actualPaths.length === expectedByPath.size &&
      actualPaths.every((path) => {
        const expected = expectedByPath.get(path);
        return expected !== undefined && readFileSync(join(packetAbs, path), 'utf8') === expected;
      });

    const freshness = clean ? '一致' : '乖離（再生成してください）';
    console.log(
      `${featureId} | パケット: あり | 判断: ${decisionLabel} | 実装との一致: ${freshness}`,
    );
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  try {
    const generator = await loadGenerator();
    const repoRoot = parsed.repoRoot === null ? toolRepoRoot : resolve(parsed.repoRoot);

    if (parsed.command === 'status') {
      runStatus(repoRoot, generator);
      return;
    }

    const featureIds =
      parsed.features === 'all' ? generator.experimentalFeatures : parsed.features;
    for (const featureId of featureIds) {
      if (!generator.experimentalFeatures.includes(featureId)) {
        throw new Error(
          `"${featureId}" は experimental 機能ではありません。対象: ${generator.experimentalFeatures.join(', ')}`,
        );
      }
    }

    if (parsed.command === 'generate') {
      for (const featureId of featureIds) {
        runGenerate(repoRoot, generator, featureId);
      }
      return;
    }

    // check
    let allClean = true;
    for (const featureId of featureIds) {
      if (!runCheck(repoRoot, generator, featureId)) allClean = false;
    }
    if (!allClean) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
