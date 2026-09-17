#!/usr/bin/env node
/**
 * リポジトリ内のテストを収集し、テスト一覧（TEST-CATALOG.md）を生成・検証する。
 *
 *   node scripts/test-catalog.mjs          # TEST-CATALOG.md を書き出す
 *   node scripts/test-catalog.mjs --check  # 書き出さず、現在の TEST-CATALOG.md と一致するか検証する
 *
 * 一覧は describe / it の階層をそのまま Markdown の入れ子リストにしたもので、
 * テストを実行しなくても「どの振る舞いをテストで固定しているか」を名前から読める。
 * テストを追加・変更したら再生成してコミットする。CI は --check で一致を検証する。
 *
 * 収集元と収集方法:
 *   - vitest（packages/core, packages/experimental, samples/hono-cloudflare）:
 *     `vitest list --json` で、実行せずにテストを収集する。samples/hono-cloudflare の
 *     契約テストは core / experimental の dist を import するため、`pnpm run build` を先に実行する。
 *   - Playwright（tests/e2e）: `playwright test --list --reporter=json`。ブラウザや OP は起動しない。
 *   - node:test（.github/scripts, tests/conformance/scripts）: 実行せずに一覧だけを得る手段が無いので、
 *     `node --test --test-reporter=tap` で実行し、TAP の Subtest 行から階層を復元する。
 *
 * 生成物に日時や実行時間は含めない。含めると内容が変わらなくても差分が出て、--check が意味を失う。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUTPUT_FILE = 'TEST-CATALOG.md';

/** 収集元。表示順がそのまま一覧の章の順になる。 */
const SOURCES = [
  {
    heading: 'packages/core',
    method: 'vitest',
    description:
      '`@maronn-openid-connect/core` の単体テスト。Edge Runtime 環境（Web 標準 API のみ）で実行する。',
    command: 'pnpm --filter @maronn-openid-connect/core test',
    collect: () => collectVitest('packages/core'),
  },
  {
    heading: 'packages/experimental',
    method: 'vitest',
    description:
      '`@maronn-openid-connect/experimental` の単体テスト。core と同じ Edge Runtime 環境で実行する。',
    command: 'pnpm --filter @maronn-openid-connect/experimental test',
    collect: () => collectVitest('packages/experimental'),
  },
  {
    heading: 'samples/hono-cloudflare',
    method: 'vitest',
    description:
      'CLI が生成した OpenID Provider の契約テスト（`conformance.test.ts`）。' +
      '生成 OP へ実際にリクエストしたときの想定挙動を固定する。' +
      'hono-cloudflare はすべての experimental 機能を有効にして生成しているので、生成 OP の契約の全体像はここで読める。',
    command: 'pnpm --filter @maronn-openid-connect/sample-hono-cloudflare test:conformance',
    collect: () => collectVitest('samples/hono-cloudflare'),
  },
  {
    heading: 'tests/e2e',
    method: 'Playwright',
    description:
      'CLI 生成 OP を起動し、E2E 専用のクライアントとリソースサーバーを相手に実ブラウザと実 HTTP で検証する E2E テスト。',
    command: 'pnpm run test:e2e',
    collect: () => collectPlaywright('tests/e2e'),
  },
  {
    heading: '.github/scripts',
    method: 'node:test',
    description:
      'CI ゲート・changeset・リリース契約・npm provenance を検証するスクリプト自身のテスト。',
    command: 'pnpm run test:supply-chain',
    collect: () => collectNodeTest('.github/scripts'),
  },
  {
    heading: 'tests/conformance',
    method: 'node:test',
    description: 'OpenID Foundation Conformance Suite ランナーの設定生成スクリプトのテスト。',
    command: 'pnpm run test:conformance',
    collect: () => collectNodeTest('tests/conformance/scripts'),
  },
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `\`${command} ${args.join(' ')}\` (cwd: ${relative(repositoryRoot, cwd) || '.'}) が終了コード ${result.status} で失敗しました。\n` +
        `${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

/** vitest: `vitest list --json` は { name: "describe > describe > it", file } の配列を書き出す。 */
function collectVitest(directory) {
  const cwd = join(repositoryRoot, directory);
  const tempDir = mkdtempSync(join(tmpdir(), 'test-catalog-'));
  try {
    const outputFile = join(tempDir, 'list.json');
    run('pnpm', ['exec', 'vitest', 'list', `--json=${outputFile}`], cwd);
    const entries = JSON.parse(readFileSync(outputFile, 'utf8'));
    return buildFiles(
      entries.map((entry) => ({
        file: toPosix(relative(cwd, entry.file)),
        path: entry.name.split(' > '),
      })),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Playwright: JSON レポートは suites（ファイル → describe）の入れ子と、その中の specs（テスト）。 */
function collectPlaywright(directory) {
  const cwd = join(repositoryRoot, directory);
  const report = JSON.parse(
    run('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], cwd),
  );
  const entries = [];
  const walk = (suite, ancestors) => {
    for (const spec of suite.specs ?? []) {
      entries.push({
        file: toPosix(relative(cwd, join(report.config.rootDir, spec.file))),
        path: [...ancestors, spec.title],
      });
    }
    for (const child of suite.suites ?? []) walk(child, [...ancestors, child.title]);
  };
  // 最上位の suite はファイルを表すので、階層には含めない。
  for (const fileSuite of report.suites ?? []) walk(fileSuite, []);
  return buildFiles(entries);
}

/**
 * node:test: TAP の `# Subtest: <name>` 行の字下げ（4 スペース = 1 段）から階層を復元する。
 * 子を持たない Subtest がテスト、子を持つ Subtest が describe に相当する。
 */
function collectNodeTest(directory) {
  const cwd = join(repositoryRoot, directory);
  const files = readdirSync(cwd)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  return files.map((name) => {
    const tap = run(process.execPath, ['--test', '--test-reporter=tap', name], cwd);
    const file = { name: toPosix(relative(repositoryRoot, join(cwd, name))), children: [], count: 0 };
    const stack = [file];
    for (const line of tap.split('\n')) {
      const match = line.match(/^( *)# Subtest: (.*)$/);
      if (!match) continue;
      const depth = match[1].length / 4 + 1;
      const node = { name: match[2].trim(), children: [] };
      stack.length = depth;
      stack[depth - 1].children.push(node);
      stack[depth] = node;
    }
    file.count = countLeaves(file);
    return file;
  });
}

function countLeaves(node) {
  if (node.children.length === 0) return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/**
 * { file, path } の一覧を、ファイルごとの木にまとめる。
 * describe（末尾以外の要素）は同名なら 1 つにまとめ、テスト（末尾の要素）は同名でも別の項目にする。
 * ファイルはパス順、ファイル内の順序は収集順（ソースの並び）を保つ。
 */
function buildFiles(entries) {
  const files = new Map();
  for (const { file, path } of entries) {
    if (!files.has(file)) files.set(file, { name: file, children: [], count: 0 });
    const fileNode = files.get(file);
    fileNode.count += 1;
    let parent = fileNode;
    path.forEach((segment, index) => {
      const isTest = index === path.length - 1;
      let node = isTest
        ? undefined
        : parent.children.find((child) => child.name === segment && child.children.length > 0);
      if (node === undefined) {
        node = { name: segment, children: [] };
        parent.children.push(node);
      }
      parent = node;
    });
  }
  return [...files.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Markdown の強調・リンク・HTML と衝突する記号をエスケープする。 */
function escapeMarkdown(text) {
  return text.replace(/\s+/g, ' ').replace(/[\\`*_[\]<>|~]/g, (char) => `\\${char}`);
}

function renderNode(node, depth, lines) {
  lines.push(`${'  '.repeat(depth)}- ${escapeMarkdown(node.name)}`);
  for (const child of node.children) renderNode(child, depth + 1, lines);
}

function render(sections) {
  const lines = [];
  lines.push('# テスト一覧');
  lines.push('');
  lines.push(
    'このファイルは `pnpm test:catalog` が生成する。手では編集せず、テストを追加・変更したら再生成してコミットする。',
  );
  lines.push('CI は `pnpm test:catalog:check` で、この一覧が現在のテストと一致することを検証する。');
  lines.push('');
  lines.push('各テストは `describe` と `it` の階層をそのまま入れ子リストにしている。');
  lines.push('テスト名は「should + 動詞」で、名前だけで何を固定しているかが分かる（`README.md` の「テストコードの書き方」）。');
  lines.push('');
  lines.push('| 区分 | 収集方法 | ファイル数 | テスト数 |');
  lines.push('|---|---|---:|---:|');
  let totalFiles = 0;
  let totalTests = 0;
  for (const section of sections) {
    const tests = section.files.reduce((sum, file) => sum + file.count, 0);
    totalFiles += section.files.length;
    totalTests += tests;
    lines.push(
      `| [${section.heading}](#${anchor(section.heading)}) | ${section.method} | ${section.files.length} | ${tests} |`,
    );
  }
  lines.push(`| 合計 | | ${totalFiles} | ${totalTests} |`);
  lines.push('');
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    lines.push(section.description);
    lines.push('');
    lines.push('```bash');
    lines.push(section.command);
    lines.push('```');
    lines.push('');
    for (const file of section.files) {
      lines.push(`### ${file.name}（${file.count}）`);
      lines.push('');
      for (const child of file.children) renderNode(child, 0, lines);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** GitHub が見出しに付けるアンカー（英数字以外を除き、空白をハイフンにする）。 */
function anchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function collectSections() {
  return SOURCES.map((source) => ({ ...source, files: source.collect() }));
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const limit = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? '(行が無い)',
        actual: actualLines[index] ?? '(行が無い)',
      };
    }
  }
  return undefined;
}

function main() {
  const check = process.argv.includes('--check');
  const outputPath = join(repositoryRoot, OUTPUT_FILE);
  const content = render(collectSections());

  if (!check) {
    writeFileSync(outputPath, content);
    console.log(`${OUTPUT_FILE} を生成しました。`);
    return;
  }

  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (current === content) {
    console.log(`${OUTPUT_FILE} は現在のテストと一致しています。`);
    return;
  }
  const difference = firstDifference(content, current);
  console.error(
    `${OUTPUT_FILE} が現在のテストと一致しません。\`pnpm test:catalog\` を実行して再生成し、コミットしてください。`,
  );
  if (difference !== undefined) {
    console.error(`  最初の差分: ${difference.line} 行目`);
    console.error(`    期待: ${difference.expected}`);
    console.error(`    現在: ${difference.actual}`);
  }
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
