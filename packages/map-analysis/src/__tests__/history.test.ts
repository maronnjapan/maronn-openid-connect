import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCli, type Cli } from '../cli.js';
import { heldRevision, isoDate, mainRevision, MAX_FILE_DIFF_LINES, originRepository, readHistory, readHistoryWithDiffs, repositoryOfRemote, splitHunks } from '../history.js';
import type { HistoryData, HistoryDetail } from '../model.js';
import type { AnalysisRoot } from '../roots.js';

const roots: AnalysisRoot[] = [{ name: 'lib', directory: 'src', exclude: [], project: '.' }];

/** Run git in a directory with the configuration of the user and of the system left out, and return what it printed. */
function git(directory: string, args: readonly string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', ...env } });
}

/** Write files of a repository (path → text), removing those given as null. */
function write(directory: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(directory, path));
      continue;
    }
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
}

/** The environment of a commit by an author on a day of January 2026 (also the committer date). */
function on(day: number, author: string): Record<string, string> {
  const date = `2026-01-0${day}T10:00:00+00:00`;
  return { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase().replace(/\s+/g, '-')}@example.com`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

/** Commit every file of the working tree with a message (its paragraphs) on a day, by an author. */
function commit(directory: string, message: readonly string[], day: number, author: string): void {
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-q', ...message.flatMap((paragraph) => ['-m', paragraph])], on(day, author));
}

const A_TS = `/** Say hello to someone. */
export function hello(name: string): string {
  return \`hello \${name}\`;
}

const greeting = 'hi';

/** Shout a text. */
export function shout(text: string): string {
  return text.toUpperCase();
}

/** Read a value as it is. */
export function parse(value: string): string;
export function parse(value: number): number;
export function parse(value: string | number): string | number {
  return value;
}

const sample = \`
function notAFunction() {}
\`;
`;

const OLD_TS = `/** The legacy way. */
export function legacy(): number {
  return 1;
}

/** Kept as it is. */
export function kept(): number {
  return 2;
}

/** Also kept as it is. */
export function alsoKept(): number {
  return 3;
}
`;

const B_TS = `/** Make the thing. */
export function thing(): string {
  return 'thing';
}

/** A helper the fix removes. */
function helper(): string {
  return 'help';
}
`;

/**
 * A repository of one root (`lib`, the directory src): a commit pushed to
 * main, a branch of two commits (by an agent) merged as pull request #3 after
 * another commit pushed to main, and a squash of pull request #4.
 */
function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'map-history-'));
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Maintainer']);
  git(directory, ['config', 'user.email', 'maintainer@example.com']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  git(directory, ['remote', 'add', 'origin', 'git@github.com:someone/library.git']);
  write(directory, {
    'README.md': '# Library\n',
    'src/a.ts': A_TS,
    'src/old.ts': OLD_TS,
    'src/gone.ts': '/** Soon gone. */\nexport function gone(): void {}\n',
    'tools/tool.ts': '/** A tool outside the roots. */\nexport function tool(): void {}\n',
  });
  commit(directory, ['Start the library'], 1, 'Alice');

  git(directory, ['checkout', '-q', '-b', 'feature-x']);
  write(directory, {
    'src/b.ts': B_TS,
    'src/a.ts': A_TS.replace('`hello ${name}`', '`hello, ${name}`'),
    'apps/map/changes/thing.md': '# The thing\n\nWhy it is made.\n',
    'apps/map/changes/README.md': '# Change notes\n',
  });
  commit(directory, ['Add the thing'], 2, 'Agent Bot');
  write(directory, { 'src/old.ts': null, 'src/renamed.ts': OLD_TS.replace('return 1;', 'return 10;') });
  commit(directory, ['Move the old module'], 3, 'Agent Bot');

  git(directory, ['checkout', '-q', 'main']);
  write(directory, { 'README.md': '# Library\n\nSays hey.\n', 'src/a.ts': A_TS.replace("'hi'", "'hey'") });
  commit(directory, ['Say hey'], 4, 'Alice');
  git(directory, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #3 from someone/feature-x', '-m', 'Add the thing', 'feature-x'], on(5, 'Maintainer'));

  write(directory, {
    'src/a.ts': A_TS.replace("'hi'", "'hey'")
      .replace('`hello ${name}`', '`hello, ${name}`')
      .replace('/** Shout a text. */', '/** Shout a text, louder. */')
      .replace('export function parse(value: number): number;', 'export function parse(value: bigint): bigint;'),
    'src/b.ts': B_TS.slice(0, B_TS.indexOf('\n/** A helper')),
    'src/gone.ts': null,
    'tools/tool.ts': '/** A tool outside the roots, changed. */\nexport function tool(): number {\n  return 1;\n}\n',
  });
  commit(directory, ['Fix it (#4)'], 6, 'Carol');
  return directory;
}

let cli: Cli;
let directory: string;
let history: HistoryData;
beforeAll(async () => {
  cli = await loadCli(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../cli/dist'));
  directory = createRepository();
  history = readHistory({ repository: directory, roots, codeMaskOf: cli.codeMaskOf, github: 'someone/library' });
});

afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

describe('mainRevision', () => {
  it('should read the newest commit of a remote main that HEAD has: not a branch not merged yet, not a main gone ahead, and the main of an upstream past a stale fork', () => {
    const directory = mkdtempSync(join(tmpdir(), 'map-history-main-'));
    try {
      git(directory, ['init', '-q', '-b', 'main']);
      git(directory, ['config', 'user.name', 'Maintainer']);
      git(directory, ['config', 'user.email', 'maintainer@example.com']);
      git(directory, ['config', 'commit.gpgsign', 'false']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'A']);
      const a = git(directory, ['rev-parse', 'HEAD']).trim();
      const alone = mainRevision(directory);
      git(directory, ['checkout', '-q', '-b', 'feature']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'Not merged']);
      git(directory, ['checkout', '-q', 'main']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'B']);
      const b = git(directory, ['rev-parse', 'HEAD']).trim();
      git(directory, ['update-ref', 'refs/remotes/origin/main', b]);
      git(directory, ['checkout', '-q', 'feature']);
      // origin/main went on to B since the branch left it at A: the branch's code has A only, also with origin/main given as the base.
      const behind = mainRevision(directory);
      expect([heldRevision(directory, 'origin/main'), heldRevision(directory, 'no-such-base')]).toEqual([{ revision: a, from: 'origin/main' }, { revision: 'no-such-base', from: 'no-such-base' }]);
      git(directory, ['merge', '-q', '--no-edit', 'main']);
      // A fork whose main stayed at A, and the upstream at B that the branch merged.
      git(directory, ['update-ref', 'refs/remotes/origin/main', a]);
      git(directory, ['update-ref', 'refs/remotes/upstream/main', b]);
      const upstream = mainRevision(directory);
      // A remote HEAD that points at a branch (a clone of a working copy) is no main.
      git(directory, ['update-ref', 'refs/remotes/upstream/feature', 'HEAD']);
      git(directory, ['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/feature']);
      expect([alone, behind, upstream, mainRevision(directory)]).toEqual([{ revision: 'HEAD', from: 'HEAD' }, { revision: a, from: 'origin/main' }, { revision: b, from: 'upstream/main' }, { revision: b, from: 'upstream/main' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should count a merge of main whose branch HEAD has, as on a branch that goes on without merging main back', () => {
    const directory = mkdtempSync(join(tmpdir(), 'map-history-held-'));
    try {
      git(directory, ['init', '-q', '-b', 'main']);
      git(directory, ['config', 'user.name', 'Maintainer']);
      git(directory, ['config', 'user.email', 'maintainer@example.com']);
      git(directory, ['config', 'commit.gpgsign', 'false']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'A']);
      git(directory, ['checkout', '-q', '-b', 'work']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'First pull request']);
      git(directory, ['checkout', '-q', 'main']);
      git(directory, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'work']);
      const merge = git(directory, ['rev-parse', 'HEAD']).trim();
      git(directory, ['update-ref', 'refs/remotes/origin/main', merge]);
      git(directory, ['checkout', '-q', 'work']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'Second pull request']);
      const first = mainRevision(directory);
      // main goes on with another branch's squash, then merges the second pull request of the branch, which still does not merge main back.
      git(directory, ['checkout', '-q', 'main']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'Other (#2)']);
      git(directory, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #3', 'work']);
      const second = git(directory, ['rev-parse', 'HEAD']).trim();
      git(directory, ['update-ref', 'refs/remotes/origin/main', second]);
      git(directory, ['checkout', '-q', 'work']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'Third pull request, not merged yet']);
      expect([first, mainRevision(directory), heldRevision(directory, 'origin/main')]).toEqual([{ revision: merge, from: 'origin/main' }, { revision: second, from: 'origin/main' }, { revision: second, from: 'origin/main' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('should reach a commit of HEAD that main has through the merge of a branch stacked on it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'map-history-stacked-'));
    try {
      git(directory, ['init', '-q', '-b', 'main']);
      git(directory, ['config', 'user.name', 'Maintainer']);
      git(directory, ['config', 'user.email', 'maintainer@example.com']);
      git(directory, ['config', 'commit.gpgsign', 'false']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'A']);
      git(directory, ['checkout', '-q', '-b', 'lower']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'W1']);
      git(directory, ['checkout', '-q', '-b', 'upper']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'Z1']);
      git(directory, ['checkout', '-q', 'main']);
      git(directory, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #2 (the upper one, first)', 'upper']);
      const merge = git(directory, ['rev-parse', 'HEAD']).trim();
      git(directory, ['update-ref', 'refs/remotes/origin/main', merge]);
      git(directory, ['checkout', '-q', 'lower']);
      git(directory, ['commit', '-q', '--allow-empty', '-m', 'W2']);
      // The changes of the lower pull request start at W1 (git merge-base), which main has through the merge of the upper one.
      expect(heldRevision(directory, 'origin/main')).toEqual({ revision: merge, from: 'origin/main' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('readHistory', () => {
  it('should list the commits of main newest first, each as a merge, a squash or a direct commit', () => {
    expect(history.version).toBe(1);
    expect(history.repository).toBe('someone/library');
    expect(history.shallow).toBeUndefined();
    expect(history.entries.map(({ kind, pr, title, branch }) => ({ kind, pr, title, branch }))).toEqual([
      { kind: 'squash', pr: 4, title: 'Fix it', branch: undefined },
      { kind: 'merge', pr: 3, title: 'Add the thing', branch: 'feature-x' },
      { kind: 'direct', pr: undefined, title: 'Say hey', branch: undefined },
      { kind: 'direct', pr: undefined, title: 'Start the library', branch: undefined },
    ]);
    expect(history.entries.map((entry) => entry.commit)).toEqual(git(directory, ['rev-list', '--first-parent', 'HEAD']).trim().split('\n'));
    expect(history.entries.map((entry) => entry.date)).toEqual(['2026-01-06T10:00:00+00:00', '2026-01-05T10:00:00+00:00', '2026-01-04T10:00:00+00:00', '2026-01-01T10:00:00+00:00']);
  });

  it('should give a merge the commits of its branch, oldest first, and their authors', () => {
    const merge = history.entries[1];
    expect(merge?.commits).toEqual([
      { sha: git(directory, ['rev-parse', 'feature-x~1']).trim(), subject: 'Add the thing', date: '2026-01-02T10:00:00+00:00', author: 'Agent Bot' },
      { sha: git(directory, ['rev-parse', 'feature-x']).trim(), subject: 'Move the old module', date: '2026-01-03T10:00:00+00:00', author: 'Agent Bot' },
    ]);
    expect(merge?.authors).toEqual(['Agent Bot']);
    expect(history.entries[0]?.commits.map((one) => [one.sha, one.subject, one.author])).toEqual([[history.entries[0]?.commit, 'Fix it (#4)', 'Carol']]);
    expect(history.entries[0]?.authors).toEqual(['Carol']);
  });

  it('should list the files a change made against its first parent, a rename with the path it had', () => {
    const merge = history.entries[1];
    expect(merge?.files.map((file) => file.path).sort()).toEqual(['apps/map/changes/README.md', 'apps/map/changes/thing.md', 'src/a.ts', 'src/b.ts', 'src/renamed.ts']);
    expect(merge?.files).toContainEqual({ path: 'src/renamed.ts', status: 'renamed', from: 'src/old.ts', additions: 1, deletions: 1 });
    expect(merge?.files).toContainEqual({ path: 'src/b.ts', status: 'added', additions: 9, deletions: 0 });
    expect(merge?.files).toContainEqual({ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 });
    expect(merge?.additions).toBe(merge?.files.reduce((sum, file) => sum + file.additions, 0));
    expect(merge?.deletions).toBe(2);
    expect(history.entries[0]?.files).toContainEqual({ path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 2 });
    expect(history.entries[3]?.files.map((file) => [file.path, file.status])).toEqual([
      ['README.md', 'added'],
      ['src/a.ts', 'added'],
      ['src/gone.ts', 'added'],
      ['src/old.ts', 'added'],
      ['tools/tool.ts', 'added'],
    ]);
  });

  it('should find the functions of the roots a change added, modified and removed as the catalog reads the text', () => {
    // The first commit: every function of the roots, an overload set once, none in a template literal or outside the roots.
    expect(history.entries[3]?.functions).toEqual([
      { id: 'lib:a.ts#hello', name: 'hello', status: 'added' },
      { id: 'lib:a.ts#shout', name: 'shout', status: 'added' },
      { id: 'lib:a.ts#parse', name: 'parse', status: 'added' },
      { id: 'lib:gone.ts#gone', name: 'gone', status: 'added' },
      { id: 'lib:old.ts#legacy', name: 'legacy', status: 'added' },
      { id: 'lib:old.ts#kept', name: 'kept', status: 'added' },
      { id: 'lib:old.ts#alsoKept', name: 'alsoKept', status: 'added' },
    ]);
    // A change of the code at the top level, outside every function, touches none.
    expect(history.entries[2]?.functions).toEqual([]);
    // The merge: a body changed, a file added, a function changed in a renamed file (by the id of its new module; the functions the rename left as they were are not listed).
    expect(history.entries[1]?.functions).toEqual([
      { id: 'lib:a.ts#hello', name: 'hello', status: 'modified' },
      { id: 'lib:b.ts#thing', name: 'thing', status: 'added' },
      { id: 'lib:b.ts#helper', name: 'helper', status: 'added' },
      { id: 'lib:renamed.ts#legacy', name: 'legacy', status: 'modified' },
    ]);
    // The squash: a JSDoc and an overload signature changed, a function and a file removed.
    expect(history.entries[0]?.functions).toEqual([
      { id: 'lib:a.ts#shout', name: 'shout', status: 'modified' },
      { id: 'lib:a.ts#parse', name: 'parse', status: 'modified' },
      { id: 'lib:b.ts#helper', name: 'helper', status: 'removed' },
      { id: 'lib:gone.ts#gone', name: 'gone', status: 'removed' },
    ]);
  });

  it('should index the changes by the functions they touched, newest first', () => {
    expect(history.functions).toEqual({
      'lib:a.ts#hello': [1, 3],
      'lib:a.ts#parse': [0, 3],
      'lib:a.ts#shout': [0, 3],
      'lib:b.ts#helper': [0, 1],
      'lib:b.ts#thing': [1],
      'lib:gone.ts#gone': [0, 3],
      'lib:old.ts#alsoKept': [3],
      'lib:old.ts#kept': [3],
      'lib:old.ts#legacy': [3],
      'lib:renamed.ts#legacy': [1],
    });
  });

  it('should list the change notes a change added, not their README', () => {
    expect(history.entries.map((entry) => entry.notes)).toEqual([[], ['apps/map/changes/thing.md'], [], []]);
  });

  it('should take the title, the body and the branch of a pull request from GitHub when given them', () => {
    const enriched = readHistory({
      repository: directory,
      roots,
      codeMaskOf: cli.codeMaskOf,
      pulls: [
        { number: 3, title: 'Add the thing, as titled on GitHub', body: 'What it does and why.', head: { ref: 'feature-x' } },
        { number: 4, title: 'Fix it', body: null, head: { ref: 'fix-it' } },
        { number: 99, title: 'Never merged' },
      ],
    });
    expect(enriched.repository).toBeUndefined();
    expect(enriched.entries.map(({ title, body, branch }) => ({ title, body, branch }))).toEqual([
      { title: 'Fix it', body: undefined, branch: 'fix-it' },
      { title: 'Add the thing, as titled on GitHub', body: 'What it does and why.', branch: 'feature-x' },
      { title: 'Say hey', body: undefined, branch: undefined },
      { title: 'Start the library', body: undefined, branch: undefined },
    ]);
  });

  it('should take a pull request only for the commit that merged it, and say which changes GitHub confirmed', () => {
    const merge = git(directory, ['rev-parse', 'HEAD~1']).trim();
    const read = readHistory({
      repository: directory,
      roots,
      codeMaskOf: cli.codeMaskOf,
      pulls: [
        { number: 3, title: 'Another repository #3', body: 'Not this one.', merge_commit_sha: 'f'.repeat(40) },
        { number: 4, title: 'Fix it, on GitHub', body: null, merge_commit_sha: null },
      ],
    });
    expect([read.pulls, read.entries.map(({ title, onGitHub }) => ({ title, onGitHub }))]).toEqual([true, [{ title: 'Fix it', onGitHub: undefined }, { title: 'Add the thing', onGitHub: undefined }, { title: 'Say hey', onGitHub: undefined }, { title: 'Start the library', onGitHub: undefined }]]);
    const matched = readHistory({ repository: directory, roots, codeMaskOf: cli.codeMaskOf, pulls: [{ number: 3, title: 'Add the thing, on GitHub', merge_commit_sha: merge }] });
    expect(matched.entries.map(({ title, onGitHub }) => ({ title, onGitHub }))[1]).toEqual({ title: 'Add the thing, on GitHub', onGitHub: true });
  });

  it('should read the history of another revision', () => {
    const before = readHistory({ repository: directory, roots, codeMaskOf: cli.codeMaskOf, revision: 'HEAD~1' });
    expect(before.entries.map((entry) => entry.title)).toEqual(['Add the thing', 'Say hey', 'Start the library']);
    expect(before.functions['lib:gone.ts#gone']).toEqual([2]);
  });

  it('should say when the clone is shallow', () => {
    const clone = mkdtempSync(join(tmpdir(), 'map-history-shallow-'));
    try {
      git(clone, ['clone', '-q', '--depth', '1', `file://${directory}`, 'repository']);
      const shallow = readHistory({ repository: join(clone, 'repository'), roots, codeMaskOf: cli.codeMaskOf });
      expect(shallow.shallow).toBe(true);
      expect(shallow.entries.map((entry) => entry.title)).toEqual(['Fix it']);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe('repositoryOfRemote', () => {
  it('should read owner/name from the url of a remote of GitHub, over https, ssh or a proxy', () => {
    expect(repositoryOfRemote('https://github.com/maronnjapan/maronn-openid-connect.git')).toBe('maronnjapan/maronn-openid-connect');
    expect(repositoryOfRemote('https://github.com/o/r')).toBe('o/r');
    expect(repositoryOfRemote('git@github.com:o/r.git\n')).toBe('o/r');
    expect(repositoryOfRemote('ssh://git@github.com/o/r.git')).toBe('o/r');
    expect(repositoryOfRemote('http://local_proxy@127.0.0.1:1234/git/owner/name')).toBe('owner/name');
  });

  it('should read nothing from a local path or a url with one segment', () => {
    expect(repositoryOfRemote('/home/user/repository')).toBeUndefined();
    expect(repositoryOfRemote('file:///home/user/repository')).toBeUndefined();
    expect(repositoryOfRemote('https://github.com/o')).toBeUndefined();
  });

  it('should read the remote origin of a repository', () => {
    expect(originRepository(directory)).toBe('someone/library');
    expect(originRepository(join(directory, 'missing'))).toBeUndefined();
  });
});

describe('the pull requests off the first-parent history, and a shallow clone', () => {
  let other: string;
  beforeAll(() => {
    other = mkdtempSync(join(tmpdir(), 'map-history-other-'));
    git(other, ['init', '-q', '-b', 'main']);
    git(other, ['config', 'user.name', 'Maintainer']);
    git(other, ['config', 'user.email', 'maintainer@example.com']);
    git(other, ['config', 'commit.gpgsign', 'false']);
    write(other, { 'src/a.ts': '/** One. */\nexport function one(): number {\n  return 1;\n}\n' });
    commit(other, ['Start'], 1, 'Alice');
    // A pull request merged into main on GitHub, while a local commit waits to be pushed.
    git(other, ['checkout', '-q', '-b', 'upstream']);
    git(other, ['checkout', '-q', '-b', 'feature']);
    write(other, { 'src/b.ts': '/** Two. */\nexport function two(): number {\n  return 2;\n}\n' });
    commit(other, ['Add two'], 2, 'Agent');
    git(other, ['checkout', '-q', 'upstream']);
    git(other, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from someone/feature', '-m', 'Add the second function', 'feature'], on(3, 'Maintainer'));
    git(other, ['checkout', '-q', 'main']);
    write(other, { 'README.md': '# Local\n' });
    commit(other, ['Write a readme'], 4, 'Alice');
    // `git pull` merges main of GitHub into the local commit, and the merge is pushed.
    git(other, ['merge', '-q', '--no-ff', '-m', "Merge branch 'main' of github.com:someone/library", 'upstream'], on(5, 'Alice'));
    // A merge whose message is the title of its pull request.
    git(other, ['checkout', '-q', '-b', 'third']);
    write(other, { 'src/c.ts': '/** Three. */\nexport function three(): number {\n  return 3;\n}\n' });
    commit(other, ['Add three'], 6, 'Agent');
    git(other, ['checkout', '-q', 'main']);
    git(other, ['merge', '-q', '--no-ff', '-m', 'Add the third function (#13)', 'third'], on(7, 'Maintainer'));
  });
  afterAll(() => rmSync(other, { recursive: true, force: true }));

  it('should list a pull request a pushed merge brought under that merge, with the text GitHub gives', () => {
    const read = readHistory({ repository: other, roots, codeMaskOf: cli.codeMaskOf, pulls: [{ number: 12, title: 'Add two', body: 'Why two.' }] });
    const pulled = read.entries.find((entry) => entry.title.startsWith("Merge branch 'main'"));
    expect([read.entries.map((entry) => entry.pr ?? null), pulled?.kind, pulled?.carried?.map(({ pr, title, body }) => ({ pr, title, body })), pulled?.functions.map((fn) => fn.id)]).toEqual([[13, null, null, null], 'merge', [{ pr: 12, title: 'Add two', body: 'Why two.' }], ['lib:b.ts#two']]);
  });

  it('should read a merge whose message is the title of its pull request as a merge, with the commits of its branch', () => {
    const merged = readHistory({ repository: other, roots, codeMaskOf: cli.codeMaskOf }).entries[0];
    expect([merged?.kind, merged?.pr, merged?.title, merged?.commits.map((one) => one.subject), merged?.authors]).toEqual(['merge', 13, 'Add the third function', ['Add three'], ['Agent']]);
  });

  it('should list no files nor functions for the oldest commit of a shallow clone', () => {
    const shallow = mkdtempSync(join(tmpdir(), 'map-history-shallow-'));
    try {
      git(tmpdir(), ['clone', '-q', '--depth', '2', `file://${other}`, shallow]);
      const read = readHistory({ repository: shallow, roots, codeMaskOf: cli.codeMaskOf });
      const oldest = read.entries[read.entries.length - 1];
      expect([read.shallow, read.entries.length, oldest?.boundary, oldest?.files, oldest?.functions, Object.keys(read.functions)]).toEqual([true, 2, true, [], [], ['lib:c.ts#three']]);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe('isoDate', () => {
  it('should write UTC as +00:00 whichever git wrote the date, and keep any other offset', () => {
    expect([isoDate('2026-01-06T10:00:00Z'), isoDate('2026-01-06T10:00:00+00:00'), isoDate('2026-11-20T18:38:57+09:00')]).toEqual(['2026-01-06T10:00:00+00:00', '2026-01-06T10:00:00+00:00', '2026-11-20T18:38:57+09:00']);
  });
});

describe('readHistoryWithDiffs', () => {
  let details: Map<string, HistoryDetail>;
  beforeAll(() => {
    details = readHistoryWithDiffs({ repository: directory, roots, codeMaskOf: cli.codeMaskOf, diffs: true }).details;
  });

  it('should keep the diff of the files of the roots only, with the hunks of each function the change touched', () => {
    const squash = details.get(history.entries[0]?.commit as string);
    const a = squash?.files.find((file) => file.path === 'src/a.ts');
    expect([squash?.files.map((file) => [file.path, file.status]), a?.functions.map((fn) => [fn.id, fn.hunks.length > 0])]).toEqual([
      [
        ['src/a.ts', 'modified'],
        ['src/b.ts', 'modified'],
        ['src/gone.ts', 'deleted'],
      ],
      [
        ['lib:a.ts#shout', true],
        ['lib:a.ts#parse', true],
      ],
    ]);
  });

  it('should write each hunk as a unified diff with its lines from the text before and after', () => {
    const merge = details.get(history.entries[1]?.commit as string);
    const a = merge?.files.find((file) => file.path === 'src/a.ts');
    const hunk = a?.functions.find((fn) => fn.id === 'lib:a.ts#hello')?.hunks[0];
    expect([hunk?.base, hunk?.head, hunk?.lines]).toEqual([1, 1, ['/** Say hello to someone. */', 'export function hello(name: string): string {', '-  return `hello ${name}`;', '+  return `hello, ${name}`;', '}', '', 'const greeting = \'hey\';'].map((line) => (line[0] === '-' || line[0] === '+' ? line : ` ${line}`))]);
  });

  it('should leave a hunk that changes no function to the file, and give a removed function the lines it lost', () => {
    const merge = details.get(history.entries[1]?.commit as string);
    const direct = details.get(history.entries[2]?.commit as string);
    const a = direct?.files.find((file) => file.path === 'src/a.ts');
    const squash = details.get(history.entries[0]?.commit as string);
    const helper = squash?.files.find((file) => file.path === 'src/b.ts')?.functions.find((fn) => fn.id === 'lib:b.ts#helper');
    const helperLines = helper?.hunks.flatMap((hunk) => hunk.lines).filter((line) => line[0] === '-');
    const outside = squash?.files.find((file) => file.path === 'src/b.ts')?.outside.flatMap((hunk) => hunk.lines).filter((line) => line[0] === '-');
    expect([a?.functions, a?.outside.length, helperLines, outside, merge?.files.find((file) => file.path === 'src/renamed.ts')?.from]).toEqual([[], 1, ['-/** A helper the fix removes. */', '-function helper(): string {', "-  return 'help';", '-}'], ['-'], 'src/old.ts']);
  });

  it('should carry the text of the change notes a change wrote, and nothing for a change of no root file or note', () => {
    const merge = details.get(history.entries[1]?.commit as string);
    expect([merge?.notes, details.has(history.entries[3]?.commit as string)]).toEqual([[{ path: 'apps/map/changes/thing.md', text: '# The thing\n\nWhy it is made.\n' }], true]);
  });

  it('should leave out the hunks of a file whose diff is too long, keeping its functions', () => {
    const big = mkdtempSync(join(tmpdir(), 'map-history-big-'));
    try {
      git(big, ['init', '-q', '-b', 'main']);
      git(big, ['config', 'user.name', 'Someone']);
      git(big, ['config', 'user.email', 'someone@example.com']);
      write(big, { 'src/big.ts': `/** Count. */\nexport function count(): number {\n${Array.from({ length: MAX_FILE_DIFF_LINES }, (_, index) => `  // ${index}`).join('\n')}\n  return 1;\n}\n` });
      commit(big, ['Add a big file'], 1, 'Someone');
      const read = readHistoryWithDiffs({ repository: big, roots, codeMaskOf: cli.codeMaskOf, diffs: true });
      const file = read.details.get(read.history.entries[0]?.commit as string)?.files[0];
      expect([file?.omitted, file?.outside, file?.functions]).toEqual(['file', [], [{ id: 'lib:big.ts#count', hunks: [] }]]);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});

describe('splitHunks', () => {
  const spans = (entries: Record<string, [number, number]>) => new Map(Object.entries(entries).map(([name, [start, end]]) => [name, { start, end }]));
  const ids = (names: string[]) => new Map(names.map((name) => [name, `lib:a.ts#${name}`]));

  it('should cut a hunk that crosses from one function to the next into a piece for each, with the context around each', () => {
    const hunk = { base: 1, head: 1, lines: [' /** F. */', ' function f() {', '-  return 1;', '+  return 2;', ' }', ' ', ' /** G. */', ' function g() {', '-  return 3;', '+  return 4;', ' }'] };
    const split = splitHunks([hunk], spans({ f: [1, 4], g: [6, 9] }), spans({ f: [1, 4], g: [6, 9] }), ids(['f', 'g']), ids(['f', 'g']));
    expect([split.functions.get('lib:a.ts#f'), split.functions.get('lib:a.ts#g'), split.outside]).toEqual([
      [{ base: 1, head: 1, lines: [' /** F. */', ' function f() {', '-  return 1;', '+  return 2;', ' }', ' ', ' /** G. */'] }],
      [{ base: 5, head: 5, lines: [' ', ' /** G. */', ' function g() {', '-  return 3;', '+  return 4;', ' }'] }],
      [],
    ]);
  });

  it('should give each function of an added file its own lines, and the rest to the file', () => {
    const hunk = { base: 0, head: 1, lines: ["+import { x } from './x';", '+', '+/** F. */', '+export function f() {}', '+', '+/** G. */', '+export function g() {}'] };
    const split = splitHunks([hunk], new Map(), spans({ f: [3, 4], g: [6, 7] }), new Map(), ids(['f', 'g']));
    expect([split.functions.get('lib:a.ts#f')?.[0]?.lines.filter((line) => line[0] === '+'), split.functions.get('lib:a.ts#g')?.[0]?.lines, split.outside.flatMap((piece) => piece.lines)]).toEqual([
      ['+/** F. */', '+export function f() {}'],
      ['+/** G. */', '+export function g() {}'],
      ["+import { x } from './x';", '+', '+'],
    ]);
  });
});

describe('the diff git gives', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'map-history-git-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Someone']);
    git(repo, ['config', 'user.email', 'someone@example.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    write(repo, { 'src/a.ts': '/**\n * F.\n */\nexport function f(): number {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  return a;\n}' });
    commit(repo, ['Start'], 1, 'Someone');
    // A constant with its JSDoc added above f, and one line of f changed further down; then the final newline added.
    write(repo, { 'src/a.ts': '/**\n * K.\n */\nexport const K = 1;\n\n/**\n * F.\n */\nexport function f(): number {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  return b;\n}' });
    commit(repo, ['Add K and change f'], 2, 'Someone');
    write(repo, { 'src/a.ts': '/**\n * K.\n */\nexport const K = 1;\n\n/**\n * F.\n */\nexport function f(): number {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  return b;\n}\n' });
    commit(repo, ['End the file with a newline'], 3, 'Someone');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('should keep a declaration added above a function out of that function, as git places it', () => {
    const read = readHistoryWithDiffs({ repository: repo, roots, codeMaskOf: cli.codeMaskOf, diffs: true });
    const file = read.details.get(read.history.entries[1]?.commit as string)?.files[0];
    expect([file?.functions.map((fn) => fn.hunks.flatMap((hunk) => hunk.lines).filter((line) => line[0] !== ' ')), file?.outside.flatMap((hunk) => hunk.lines).filter((line) => line[0] !== ' ')]).toEqual([
      [['-  return a;', '+  return b;']],
      ['+/**', '+ * K.', '+ */', '+export const K = 1;', '+'],
    ]);
  });

  it('should show the change of the last line when only its newline was added', () => {
    const read = readHistoryWithDiffs({ repository: repo, roots, codeMaskOf: cli.codeMaskOf, diffs: true });
    const file = read.details.get(read.history.entries[0]?.commit as string)?.files[0];
    expect(file?.functions).toEqual([{ id: 'lib:a.ts#f', hunks: [{ base: 12, head: 12, lines: ['   const c = 3;', '   const d = 4;', '   return b;', '-}', '+}'] }] }]);
  });
});
