/**
 * 生成コードツリー（{path, content} の配列）2 つを比較するためのモジュール。
 *
 * - classifyTrees: ファイル単位の増減・変更を分類する純粋関数
 * - renderUnifiedDiff: git diff --no-index による unified diff テキスト生成
 * - diffStats: patch テキストから件数を集計する純粋関数
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 2 つの生成ツリーをファイル単位で分類する。
 * 返り値の各配列はパスの辞書順でソートされる。
 */
export function classifyTrees(baselineFiles, enabledFiles) {
  const baselineByPath = new Map(baselineFiles.map((f) => [f.path, f.content]));
  const enabledByPath = new Map(enabledFiles.map((f) => [f.path, f.content]));

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [path, content] of enabledByPath) {
    if (!baselineByPath.has(path)) {
      added.push(path);
    } else if (baselineByPath.get(path) !== content) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }
  for (const path of baselineByPath.keys()) {
    if (!enabledByPath.has(path)) removed.push(path);
  }

  const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    changed: changed.sort(byPath),
    unchanged: unchanged.sort(byPath),
  };
}

function writeTree(rootDir, files) {
  mkdirSync(rootDir, { recursive: true });
  for (const file of files) {
    const target = join(rootDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

/**
 * 2 つの生成ツリーの unified diff を git diff --no-index で生成する。
 *
 * ツリー名（baselineName / enabledName）はそのまま patch のパスラベルになる。
 * 例: `a/default-op/routes/authorize.ts` と `b/with-par/routes/authorize.ts`。
 *
 * ユーザーやシステムの git 設定に出力が左右されないよう、設定を遮断した上で
 * 明示オプションのみで実行する。差分が無ければ空文字列を返す。
 */
export function renderUnifiedDiff(baselineFiles, enabledFiles, baselineName, enabledName) {
  const workDir = mkdtempSync(join(tmpdir(), 'maronn-exp-review-'));
  try {
    writeTree(join(workDir, baselineName), baselineFiles);
    writeTree(join(workDir, enabledName), enabledFiles);

    try {
      execFileSync(
        'git',
        [
          '-c',
          'core.quotepath=false',
          'diff',
          '--no-index',
          '--no-color',
          '--unified=3',
          baselineName,
          enabledName,
        ],
        {
          cwd: workDir,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            LC_ALL: 'C',
          },
        },
      );
      return '';
    } catch (error) {
      // git diff は差分ありのとき exit code 1 で patch を stdout に出す。
      if (error.status === 1 && typeof error.stdout === 'string') {
        return error.stdout;
      }
      throw error;
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** patch テキストからファイル数・追加行数・削除行数を集計する。 */
export function diffStats(patch) {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    else if (line.startsWith('+')) insertions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { files, insertions, deletions };
}
