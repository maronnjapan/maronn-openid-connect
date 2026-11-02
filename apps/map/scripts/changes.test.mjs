import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachNotes,
  catalogRoots,
  changesMarkdown,
  collectChanges,
  compareFiles,
  diffLines,
  functionsOfFile,
  hunksOf,
  isNote,
  moduleOf,
  parseNameStatus,
  parseNote,
  pullRequestOf,
  referencesOf,
  resolveReference,
} from './changes.mjs';

/**
 * A stand-in for analyzeFunctions of the CLI, enough for these sources: a
 * function is a line `function name(` (exported or not) up to the next line
 * that is `}`, with the `/** ... *\/` block that ends right above it.
 */
function analyze(roots) {
  const functions = {};
  const spans = {};
  for (const root of roots) {
    for (const [module, text] of root.files) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        const match = /^(?:export )?function (\w+)\(/.exec(line);
        if (!match) return;
        const name = match[1];
        const id = `${root.name}:${module}#${name}`;
        const end = lines.findIndex((candidate, at) => at > index && candidate === '}') + 1;
        const doc = index > 0 && lines[index - 1].endsWith('*/') ? lines.slice(0, index).findLastIndex((candidate) => candidate.startsWith('/**')) + 1 : undefined;
        functions[id] = { id, name, package: root.name, module, line: index + 1, summary: `${name} does it.` };
        spans[id] = doc === undefined ? { start: index + 1, end } : { doc, start: index + 1, end };
      });
    }
  }
  return { catalog: { functions }, spanOf: (id) => spans[id] };
}

const roots = catalogRoots(
  {
    libraries: { core: { directory: '../core/src', exclude: ['\\.test\\.ts$'] } },
    sources: { hono: { directory: '../../apps/hono/src', include: ['oidc-provider'], exclude: ['\\.test\\.ts$'] } },
  },
  'packages/cli',
);

describe('catalogRoots', () => {
  it('should place the directories of extract.json in the repository, relative to the CLI package', () => {
    expect(roots.map((root) => [root.name, root.directory, root.include])).toEqual([
      ['core', 'packages/core/src', undefined],
      ['hono', 'apps/hono/src', ['oidc-provider']],
    ]);
  });
});

describe('moduleOf', () => {
  it('should give the root and the module of a source the catalog reads', () => {
    expect(moduleOf(roots, 'packages/core/src/client-auth.ts')).toEqual({ root: 'core', module: 'client-auth.ts' });
    expect(moduleOf(roots, 'apps/hono/src/oidc-provider/token/pipeline.ts')).toEqual({ root: 'hono', module: 'oidc-provider/token/pipeline.ts' });
  });

  it('should leave out the tests, the entries a source does not include and the files that are not TypeScript', () => {
    expect(moduleOf(roots, 'packages/core/src/client-auth.test.ts')).toBe(undefined);
    expect(moduleOf(roots, 'apps/hono/src/main.ts')).toBe(undefined);
    expect(moduleOf(roots, 'packages/core/src/README.md')).toBe(undefined);
    expect(moduleOf(roots, 'packages/core-extra/src/a.ts')).toBe(undefined);
  });
});

describe('isNote', () => {
  it('should take the Markdown files of the notes directory except its README', () => {
    expect(isNote('apps/map/changes/claims.md')).toBe(true);
    expect(isNote('apps/map/changes/README.md')).toBe(false);
    expect(isNote('apps/map/README.md')).toBe(false);
    expect(isNote('apps/map/changes/claims.txt')).toBe(false);
  });
});

describe('parseNameStatus', () => {
  it('should read added, modified, deleted and renamed files with their paths before and after', () => {
    const output = ['A', 'new.ts', 'M', 'same.ts', 'D', 'gone.ts', 'R087', 'old.ts', 'moved.ts', ''].join('\0');
    expect(parseNameStatus(output)).toEqual([
      { status: 'A', after: 'new.ts' },
      { status: 'M', before: 'same.ts', after: 'same.ts' },
      { status: 'D', before: 'gone.ts' },
      { status: 'R', before: 'old.ts', after: 'moved.ts' },
    ]);
  });
});

describe('diffLines', () => {
  it('should keep the common lines and remove and add the others', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']).map((op) => op.op)).toEqual([' ', '-', '+', ' ', ' ', '+']);
  });

  it('should keep every line of two equal texts', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
      { op: ' ', a: 0, b: 0 },
      { op: ' ', a: 1, b: 1 },
    ]);
  });
});

describe('hunksOf', () => {
  it('should write the changes with the lines around them from the lines of the base and the head', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10'];
    expect(hunksOf(diffLines(a, b), a, b, 20, 30, 2)).toEqual({
      hunks: [{ base: 22, head: 32, lines: [' 3', ' 4', '-5', '+five', ' 6', ' 7'] }],
      added: [34],
    });
  });

  it('should split changes whose context does not meet into hunks of their own', () => {
    const a = ['a', '1', '2', '3', '4', '5', '6', 'b'];
    const b = ['A', '1', '2', '3', '4', '5', '6', 'B'];
    expect(hunksOf(diffLines(a, b), a, b, 1, 1, 1).hunks).toEqual([
      { base: 1, head: 1, lines: ['-a', '+A', ' 1'] },
      { base: 7, head: 7, lines: [' 6', '-b', '+B'] },
    ]);
  });
});

describe('functionsOfFile', () => {
  it('should split a function into its JSDoc and its code, from the line its JSDoc opens on', () => {
    const text = 'import x;\n/** Pad a value. */\nexport function pad(value) {\n  return value;\n}\n';
    expect(functionsOfFile(analyze, 'core', 'pad.ts', text).get('pad')).toEqual({
      id: 'core:pad.ts#pad',
      name: 'pad',
      line: 3,
      summary: 'pad does it.',
      from: 2,
      doc: ['/** Pad a value. */'],
      code: ['export function pad(value) {', '  return value;', '}'],
    });
  });
});

describe('compareFiles', () => {
  const file = (root, module, text) => ({ module, functions: functionsOfFile(analyze, root, module, text) });

  describe('one file', () => {
    const before = file('core', 'a.ts', '/** Keep. */\nfunction keep() {\n}\n/** Old doc. */\nfunction doc() {\n}\nfunction code() {\n  return 1;\n}\nfunction gone() {\n}\n');
    const after = file('core', 'a.ts', '/** Keep. */\nfunction keep() {\n}\n/** New doc. */\nfunction doc() {\n}\nfunction code() {\n  return 2;\n}\nfunction fresh() {\n}\n');
    const changes = compareFiles([{ root: 'core', before, after }]);

    it('should tell added, rewritten, documented and removed functions, and leave out the ones that did not change', () => {
      expect(changes.map((change) => [change.id, change.kind])).toEqual([
        ['core:a.ts#code', 'modified'],
        ['core:a.ts#doc', 'docs'],
        ['core:a.ts#fresh', 'added'],
        ['core:a.ts#gone', 'removed'],
      ]);
    });

    it('should give a changed function the lines of the head it adds and its hunks', () => {
      expect(changes[0]).toEqual({
        id: 'core:a.ts#code',
        name: 'code',
        package: 'core',
        module: 'a.ts',
        line: 7,
        kind: 'modified',
        changedLines: [8],
        hunks: [{ base: 7, head: 7, lines: [' function code() {', '-  return 1;', '+  return 2;', ' }'] }],
      });
    });

    it('should keep the summary a removed function had', () => {
      expect(changes[3]?.summary).toBe('gone does it.');
    });
  });

  describe('moves', () => {
    it('should tell a function that moved to another file of its root, and one that moved and changed', () => {
      const changes = compareFiles([
        { root: 'core', before: file('core', 'a.ts', 'function same() {\n}\nfunction edited() {\n  a();\n}\n'), after: file('core', 'a.ts', '') },
        { root: 'core', before: undefined, after: file('core', 'b.ts', 'function same() {\n}\nfunction edited() {\n  b();\n}\n') },
      ]);
      expect(changes.map((change) => [change.id, change.kind, change.from])).toEqual([
        ['core:b.ts#edited', 'modified', 'a.ts'],
        ['core:b.ts#same', 'moved', 'a.ts'],
      ]);
    });

    it('should not pair functions of the same name that two files add', () => {
      const changes = compareFiles([
        { root: 'core', before: file('core', 'a.ts', 'function x() {\n}\n'), after: undefined },
        { root: 'core', after: file('core', 'b.ts', 'function x() {\n}\n') },
        { root: 'core', after: file('core', 'c.ts', 'function x() {\n}\n') },
      ]);
      expect(changes.map((change) => [change.id, change.kind])).toEqual([
        ['core:a.ts#x', 'removed'],
        ['core:b.ts#x', 'added'],
        ['core:c.ts#x', 'added'],
      ]);
    });
  });
});

describe('referencesOf', () => {
  it('should take the names of a heading, with backticks, () and the words after them left out', () => {
    expect(referencesOf('`verifyClientSecret()` の比較、core:sha256, hono:oidc-provider/a.ts#run')).toEqual([
      'verifyClientSecret',
      'core:sha256',
      'hono:oidc-provider/a.ts#run',
    ]);
    expect(referencesOf('verifyClientSecret()を定数時間にした')).toEqual(['verifyClientSecret']);
  });
});

describe('parseNote', () => {
  it('should read the title, the summary and a section per heading, and keep a heading in a code block as text', () => {
    const text = '# クレームのアロウリスト\n\nresolver の余分なフィールドを出さない。\n\n## filterClaims, `core:isAllowed()`\n\n名前を絞る。\n\n```md\n## not a heading\n```\n\n## 背景\nなぜ\n';
    expect(parseNote(text)).toEqual({
      title: 'クレームのアロウリスト',
      summary: 'resolver の余分なフィールドを出さない。',
      sections: [
        { heading: 'filterClaims, `core:isAllowed()`', references: ['filterClaims', 'core:isAllowed'], text: '名前を絞る。\n\n```md\n## not a heading\n```' },
        { heading: '背景', references: ['背景'], text: 'なぜ' },
      ],
    });
  });

  it('should take everything for the summary of a note without headings', () => {
    expect(parseNote('\nただの説明。\n')).toEqual({ summary: 'ただの説明。', sections: [] });
  });
});

describe('resolveReference', () => {
  const cards = [
    { id: 'core:a.ts#run', name: 'run', package: 'core', module: 'a.ts' },
    { id: 'hono:oidc-provider/token/b.ts#run', name: 'run', package: 'hono', module: 'oidc-provider/token/b.ts' },
  ];
  const ids = (reference) => resolveReference(reference, cards).map((card) => card.id);

  it('should find a function by its name, in a root, by its id and by the end of its module', () => {
    expect(ids('run')).toEqual(['core:a.ts#run', 'hono:oidc-provider/token/b.ts#run']);
    expect(ids('hono:run')).toEqual(['hono:oidc-provider/token/b.ts#run']);
    expect(ids('core:a.ts#run')).toEqual(['core:a.ts#run']);
    expect(ids('token/b.ts#run')).toEqual(['hono:oidc-provider/token/b.ts#run']);
  });

  it('should find nothing for a name no function has', () => {
    expect(ids('walk')).toEqual([]);
  });
});

describe('attachNotes', () => {
  it('should give the sections to the changed functions they name, add the other functions they name as noted, and return the rest and the unknown names', () => {
    const functions = [{ id: 'core:a.ts#run', name: 'run', package: 'core', module: 'a.ts', line: 3, kind: 'modified' }];
    const cards = [
      { id: 'core:a.ts#run', name: 'run', package: 'core', module: 'a.ts', line: 3 },
      { id: 'core:b.ts#walk', name: 'walk', package: 'core', module: 'b.ts', line: 9 },
    ];
    const notes = [{ file: 'apps/map/changes/x.md', ...parseNote('## run\n速くした。\n\n## walk\n変えていないが run から呼ばれる。\n\n## 背景\n遅かった。\n\n## run, missing\n二度目。\n') }];
    expect(attachNotes(functions, notes, cards)).toEqual({
      unmatched: [{ file: 'apps/map/changes/x.md', heading: '背景', text: '遅かった。' }],
      unknown: [{ file: 'apps/map/changes/x.md', reference: 'missing' }],
    });
    expect(functions).toEqual([
      {
        id: 'core:a.ts#run',
        name: 'run',
        package: 'core',
        module: 'a.ts',
        line: 3,
        kind: 'modified',
        notes: [
          { file: 'apps/map/changes/x.md', text: '速くした。' },
          { file: 'apps/map/changes/x.md', text: '二度目。' },
        ],
      },
      { id: 'core:b.ts#walk', name: 'walk', package: 'core', module: 'b.ts', line: 9, kind: 'noted', notes: [{ file: 'apps/map/changes/x.md', text: '変えていないが run から呼ばれる。' }] },
    ]);
  });
});

describe('pullRequestOf', () => {
  it('should read the pull request from the environment, and nothing without a number', () => {
    expect(pullRequestOf({ MAP_PR: '42', MAP_PR_TITLE: 'Claims', MAP_PR_URL: 'https://github.com/o/r/pull/42' })).toEqual({ number: 42, title: 'Claims', url: 'https://github.com/o/r/pull/42' });
    expect(pullRequestOf({ MAP_PR: '' })).toBe(undefined);
  });
});

describe('changesMarkdown', () => {
  it('should count the kinds, quote the notes and list the functions with the first line of what the notes say, counting only the bare JSDoc changes', () => {
    const markdown = changesMarkdown({
      base: { ref: 'origin/main', commit: 'abc' },
      head: { commit: 'def', dirty: false },
      notes: [{ file: 'apps/map/changes/x.md', title: 'Claims', summary: '絞る。\n\n詳しく。' }],
      functions: [
        { id: 'core:a.ts#run', name: 'run', package: 'core', module: 'a.ts', line: 3, kind: 'modified', notes: [{ file: 'apps/map/changes/x.md', text: '速く | した。\n続き。' }] },
        { id: 'core:b.ts#add', name: 'add', package: 'core', module: 'b.ts', line: 1, kind: 'added' },
        { id: 'core:c.ts#doc', name: 'doc', package: 'core', module: 'c.ts', line: 1, kind: 'docs' },
        { id: 'core:d.ts#told', name: 'told', package: 'core', module: 'd.ts', line: 1, kind: 'docs', notes: [{ file: 'apps/map/changes/x.md', text: '言い換えた。' }] },
      ],
      unmatched: [],
      otherFiles: 2,
    });
    expect(markdown).toBe(
      [
        '### このPRで変わった関数（4）',
        '',
        '追加 1 · 変更 1 · JSDoc だけ変更 2',
        '',
        '> **Claims** 絞る。',
        '> — `apps/map/changes/x.md`',
        '',
        '| | 関数 | 場所 | 説明 |',
        '|---|---|---|---|',
        '| 追加 | `add()` | core b.ts | （説明なし） |',
        '| 変更 | `run()` | core a.ts | 速く \\| した。 |',
        '| JSDoc だけ変更 | `told()` | core d.ts | 言い換えた。 |',
        '',
        '説明のない、JSDoc だけ変えた関数 1 個は表に入れていません（地図の「このPRの変更」にあります）。',
        '',
      ].join('\n'),
    );
  });
});

describe('collectChanges', () => {
  let repository;
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=map', '-c', 'user.email=map@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repository, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  };

  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), 'map-changes-'));
    git('init', '--quiet', '--initial-branch=main');
    write('packages/core/src/a.ts', '/** Run. */\nexport function run() {\n  return 1;\n}\n\nfunction stay() {\n}\n');
    write('packages/core/src/old-name.ts', 'export function moved() {\n}\n');
    write('packages/core/src/gone.ts', 'export function gone() {\n}\n');
    write('apps/map/changes/earlier.md', '## run\n前の PR のメモ。\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    git('switch', '--quiet', '-c', 'feature');
    write('packages/core/src/a.ts', '/** Run. */\nexport function run() {\n  return 2;\n}\n\nfunction stay() {\n}\n');
    renameSync(join(repository, 'packages/core/src/old-name.ts'), join(repository, 'packages/core/src/new-name.ts'));
    rmSync(join(repository, 'packages/core/src/gone.ts'));
    write('packages/core/src/a.test.ts', 'function test() {\n}\n');
    write('apps/map/changes/feature.md', '# Feature\n\n速くする。\n\n## run\n2 を返す。\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'feature');
    // Uncommitted work counts too: the map is built from the working tree.
    write('packages/core/src/draft.ts', 'export function draft() {\n}\n');
  });

  afterAll(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  it('should list the functions the branch and the working tree change since the base, with the notes they add', () => {
    const { changes, unknown } = collectChanges({ repositoryRoot: repository, base: 'main', roots, analyze, cards: [], pullRequest: { number: 7 } });
    expect(changes.base).toEqual({ ref: 'main', commit: git('rev-parse', 'main') });
    expect(changes.head).toEqual({ commit: git('rev-parse', 'HEAD'), dirty: true });
    expect(changes.pullRequest).toEqual({ number: 7 });
    expect(changes.notes).toEqual([{ file: 'apps/map/changes/feature.md', title: 'Feature', summary: '速くする。' }]);
    expect(changes.functions.map((change) => [change.id, change.kind, change.from, change.notes])).toEqual([
      ['core:a.ts#run', 'modified', undefined, [{ file: 'apps/map/changes/feature.md', text: '2 を返す。' }]],
      ['core:draft.ts#draft', 'added', undefined, undefined],
      ['core:gone.ts#gone', 'removed', undefined, undefined],
      ['core:new-name.ts#moved', 'moved', 'old-name.ts', undefined],
    ]);
    expect(changes.otherFiles).toBe(1);
    expect(unknown).toEqual([]);
  });
});
