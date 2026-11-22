import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'history.mjs');

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'map-history-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a built map under the temporary directory: path → JSON. */
function write(files) {
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  }
}

/** Run the command; the site is the temporary directory unless the arguments name one. An env value of null leaves that variable out. */
function run(args, env = {}, cwd = undefined) {
  const merged = { ...process.env, MAP_SITE: root, ...env };
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: merged, ...(cwd === undefined ? {} : { cwd }) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const fn = (id, name, source) => ({ id, name, package: 'core', module: 'a.ts', line: 1, calledBy: [], source });
const map = {
  functions: { 'core:a.ts#verify': fn('core:a.ts#verify', 'verify', { file: 's1', start: 10, end: 24 }), 'experimental:b.ts#verify': fn('experimental:b.ts#verify', 'verify', { file: 's2', start: 1, end: 3 }) },
  bodies: { 'endpoint:token': { id: 'endpoint:token', name: 'POST /token', endpoint: 'token', package: 'core', module: 'a.ts', calls: [], source: { file: 's1', start: 30, end: 40 } } },
  sources: { s1: { path: 'packages/core/src/a.ts', url: '' }, s2: { path: 'packages/experimental/src/b.ts', url: '' } },
  history: './data/history/history-1.json',
};
const entry = {
  commit: `b${'1'.repeat(39)}`,
  date: '2026-11-21T10:00:00+09:00',
  kind: 'merge',
  pr: 209,
  title: 'クライアント認証を足す',
  authors: ['Claude'],
  commits: [{ sha: `c${'2'.repeat(39)}`, subject: 'verify を直す', date: '2026-11-21T09:00:00+09:00', author: 'Claude' }],
  files: [{ path: 'packages/core/src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
  functions: [{ id: 'core:a.ts#verify', name: 'verify', status: 'modified' }],
  notes: [],
  additions: 1,
  deletions: 1,
  detail: './data/history/b-1.json',
};
const history = { version: 1, entries: [entry], functions: { 'core:a.ts#verify': [0] } };
const detail = { version: 1, commit: entry.commit, notes: [], files: [{ path: 'packages/core/src/a.ts', status: 'modified', functions: [{ id: 'core:a.ts#verify', hunks: [{ base: 10, head: 10, lines: ['-  return 1;', '+  return 2;'] }] }], outside: [] }] };
const site = { 'data/map.json': map, 'data/history/history-1.json': history, 'data/history/b-1.json': detail };

describe('the history command', () => {
  it('should list the latest changes with their keys', () => {
    write(site);
    const result = run([]);
    expect([result.status, result.stdout.split('\n').slice(0, 3)]).toEqual([0, ['# main に入った変更（新しい順、1 / 1。b111111111 まで）', '', '- pr-209 2026-11-21 #209 クライアント認証を足す（関数 +0 ~1 -0）']]);
  });

  it('should write a change named by its number, with the diff of each function and where it is now', () => {
    write(site);
    const result = run(['--', '#209']);
    // pnpm passes its `--` on: an option after it is still read as one.
    expect(run(['--', 'pr-209', '--summary']).stdout).toContain('（見取り図）');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('- 今のコード: packages/core/src/a.ts:10-24\n\n```diff\n@@ -10,1 +10,1 @@\n-  return 1;\n+  return 2;\n```');
    expect(run(['209', '--summary']).stdout).toContain('### packages/core/src/a.ts\n\n- 変更 `verify()` 10-24（+1 −1 行）');
  });

  it('should open a change by a commit of its branch, and one function of a change by its name', () => {
    write(site);
    expect(run(['c2222222']).stdout.split('\n')[0]).toBe('# PR #209: クライアント認証を足す');
    const one = run(['pr-209', '--function', 'verify']);
    expect([one.status, one.stdout.split('\n')[0]]).toEqual([0, '# `verify()` の変更の履歴（PR #209: クライアント認証を足す）']);
    expect(run(['#209', '--function', 'token'])).toMatchObject({ status: 1, stderr: 'The change pr-209 changed no function token: run pnpm map:history pr-209 --summary for its functions.\n' });
    // An endpoint body is no function of the change: the change touched it by changing its file.
    expect(run(['pr-209', '--function', 'POST /token']).stdout.split('\n')[0]).toBe('# `POST /token` の変更の履歴（PR #209: クライアント認証を足す）');
  });

  it('should write the changes of a function named by its id, and ask for an id when a name is not enough', () => {
    write(site);
    expect(run(['--function', 'core:a.ts#verify']).stdout).toContain('## PR #209: クライアント認証を足す');
    const result = run(['--function', 'verify']);
    expect([result.status, result.stderr]).toEqual([1, 'Several functions are named verify; pass one of these ids:\n  core:a.ts#verify  packages/core/src/a.ts:10\n  experimental:b.ts#verify  packages/experimental/src/b.ts:1\n']);
  });

  it('should say what is wrong: a change or a function it does not have, a map without the history, no map, a limit that is no count', () => {
    write(site);
    expect(run(['pr-1'])).toMatchObject({ status: 1, stderr: 'No change pr-1 in the history of the map (1 changes; run pnpm map:history to list the latest).\n' });
    expect(run(['--function', 'none'])).toMatchObject({ status: 1, stderr: 'No function none in the map nor in its history.\n' });
    expect(run(['--limit', '0']).status).toBe(1);
    expect(run(['--sumary'])).toMatchObject({ status: 1, stderr: expect.stringContaining("Unknown option '--sumary'") });
    expect(run(['--sumary']).stderr).toContain('Usage: pnpm map:history');
    expect(run(['pr-209', 'pr-1']).stderr).toContain("Name one change, not 2 (pr-209 pr-1). In a shell, quote a number with #: '#219'.");
    expect(run(['--summary']).stderr).toContain('--summary is the outline of a change: name the change, without --function.');
    expect(run(['--function', 'constructor'])).toMatchObject({ status: 1, stderr: 'No function constructor in the map nor in its history.\n' });
    write({ 'data/map.json': { ...map, history: undefined } });
    expect(run([]).stderr).toContain('was built without the history of main');
    expect(run([], { MAP_SITE: join(root, 'none') }).stderr).toContain('build it with pnpm run build:map');
  });

  it('should read a directory given as a site from where pnpm was run, and from the directory it runs in without pnpm', () => {
    write(site);
    expect(run(['--site', '.'], { MAP_SITE: '', INIT_CWD: root, npm_lifecycle_event: 'history' }).status).toBe(0);
    expect(run(['--site', '.'], { MAP_SITE: '', INIT_CWD: tmpdir(), npm_lifecycle_event: null }, root).status).toBe(0);
  });
});
