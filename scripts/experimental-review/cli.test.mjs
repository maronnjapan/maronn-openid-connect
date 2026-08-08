import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCliArgs } from './cli.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(scriptDir, 'cli.mjs');
/** cli.mjs と同じ「このツール自身が住むリポジトリ」の解決。 */
const toolRepoRoot = resolve(scriptDir, '../..');

test('parseCliArgs', async (t) => {
  await t.test('should parse a single feature generate command', () => {
    assert.deepEqual(parseCliArgs(['par']), {
      command: 'generate',
      features: ['par'],
      repoRoot: null,
    });
  });

  await t.test('should parse --check as the check command', () => {
    assert.deepEqual(parseCliArgs(['par', '--check']), {
      command: 'check',
      features: ['par'],
      repoRoot: null,
    });
  });

  await t.test('should parse --all with --check', () => {
    assert.deepEqual(parseCliArgs(['--all', '--check']), {
      command: 'check',
      features: 'all',
      repoRoot: null,
    });
  });

  await t.test('should parse the status command', () => {
    assert.deepEqual(parseCliArgs(['status']), {
      command: 'status',
      features: 'all',
      repoRoot: null,
    });
  });

  await t.test('should parse --repo-root', () => {
    assert.deepEqual(parseCliArgs(['par', '--repo-root', '/tmp/fixture']), {
      command: 'generate',
      features: ['par'],
      repoRoot: '/tmp/fixture',
    });
  });

  await t.test('should reject an empty invocation', () => {
    assert.throws(() => parseCliArgs([]), /使い方/);
  });

  await t.test('should reject a feature together with --all', () => {
    assert.throws(() => parseCliArgs(['par', '--all']), /使い方/);
  });

  await t.test('should reject an unknown option', () => {
    assert.throws(() => parseCliArgs(['par', '--force']), /使い方/);
  });

  await t.test('should ignore a bare -- separator forwarded by pnpm', () => {
    assert.deepEqual(parseCliArgs(['par', '--', '--check']), {
      command: 'check',
      features: ['par'],
      repoRoot: null,
    });
  });
});

/** CLI サブプロセス実行。exit code と stdout/stderr を返す。 */
function runCli(args, options = {}) {
  try {
    const stdout = execFileSync('node', [cliPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

/** cli e2e 用の最小リポジトリ（par のタスク文書のみ）。生成は実 CLI dist を使う。 */
function buildFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'maronn-exp-review-cli-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(
    'tasks/experimental/done/par/specification.md',
    '# Experimental機能仕様書: PAR\n\n- **準拠仕様**: RFC 9126 - OAuth 2.0 Pushed Authorization Requests\n',
  );
  write('tasks/experimental/done/par/state.yaml', 'status: Implemented\n');
  return root;
}

test('cli end-to-end against a fixture repo', async (t) => {
  const root = buildFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packetDir = join(root, 'tasks/experimental/done/par/promotion-review');

  await t.test('generate should create the packet with README, diffs and decision.md', () => {
    const result = runCli(['par', '--repo-root', root]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(packetDir, 'README.md')), true);
    assert.equal(existsSync(join(packetDir, 'decision.md')), true);
    const generatedDocs = readdirSync(join(packetDir, 'generated-code'));
    assert.equal(generatedDocs.length > 0, true);
    const readme = readFileSync(join(packetDir, 'README.md'), 'utf8');
    assert.equal(readme.split('\n')[0], '# 昇格レビューパケット: par');
    assert.equal(result.stdout.includes('tasks/experimental/done/par/promotion-review'), true);
  });

  await t.test('check should pass immediately after generate', () => {
    const result = runCli(['par', '--check', '--repo-root', root]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes('par: パケットは実装と一致しています'), true);
  });

  await t.test('generate should never overwrite decision.md', () => {
    appendFileSync(join(packetDir, 'decision.md'), '\n人間のメモ: ここは残るべき\n');
    const result = runCli(['par', '--repo-root', root]);
    assert.equal(result.status, 0);
    const decision = readFileSync(join(packetDir, 'decision.md'), 'utf8');
    assert.equal(decision.includes('人間のメモ: ここは残るべき'), true);
  });

  await t.test('check should fail and name the file when the packet drifts', () => {
    appendFileSync(join(packetDir, 'README.md'), '改変\n');
    const result = runCli(['par', '--check', '--repo-root', root]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.includes('README.md'), true);
    assert.equal(result.stdout.includes('pnpm review:experimental par'), true);
  });

  await t.test('generate should restore the drifted packet and delete stale files', () => {
    writeFileSync(join(packetDir, 'generated-code', 'obsolete.md'), '古い生成物\n');
    const result = runCli(['par', '--repo-root', root]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(packetDir, 'generated-code', 'obsolete.md')), false);
    const check = runCli(['par', '--check', '--repo-root', root]);
    assert.equal(check.status, 0);
  });

  await t.test('check should fail with guidance when the packet does not exist', () => {
    rmSync(packetDir, { recursive: true, force: true });
    const result = runCli(['par', '--check', '--repo-root', root]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.includes('パケットが未生成です'), true);
  });

  await t.test('status should show packet/decision/freshness per feature', () => {
    runCli(['par', '--repo-root', root]);
    const result = runCli(['status', '--repo-root', root]);
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout.includes('par | パケット: あり | 判断: pending | 実装との一致: 一致'),
      true,
    );
    assert.equal(
      result.stdout.includes('token-exchange | パケット: なし（タスク文書なし）'),
      true,
    );
  });

  await t.test('should reject an unknown feature id with the valid list', async () => {
    // 有効な一覧はテストに焼き付けず CLI 自身の EXPERIMENTAL_FEATURES から取る。
    // 焼き付けると、新しい experimental 機能を足すたびにこのテストが実装より先に
    // 落ちる（device-authorization-grant の追加で実際にそうなった）。
    const { EXPERIMENTAL_FEATURES } = await import(
      pathToFileURL(join(toolRepoRoot, 'packages/cli/dist/features.js')).href
    );
    const result = runCli(['no-such-experimental-feature', '--repo-root', root]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes([...EXPERIMENTAL_FEATURES].join(', ')), true);
  });

  await t.test('should explain when the feature has no task directory', () => {
    const result = runCli(['token-exchange', '--repo-root', root]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('tasks/experimental/token-exchange'), true);
  });
});
