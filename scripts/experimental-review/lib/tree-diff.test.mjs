import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrees, renderUnifiedDiff, diffStats } from './tree-diff.mjs';

const baseline = [
  { path: 'app.ts', content: 'line1\nline2\n' },
  { path: 'routes/token.ts', content: 'token\n' },
  { path: 'routes/login.ts', content: 'login\n' },
];

const enabled = [
  { path: 'app.ts', content: 'line1\nline2 changed\n' },
  { path: 'routes/token.ts', content: 'token\n' },
  { path: 'routes/par.ts', content: 'par route\n' },
];

test('classifyTrees', async (t) => {
  await t.test('should classify added, removed, changed and unchanged paths', () => {
    assert.deepEqual(classifyTrees(baseline, enabled), {
      added: ['routes/par.ts'],
      removed: ['routes/login.ts'],
      changed: ['app.ts'],
      unchanged: ['routes/token.ts'],
    });
  });

  await t.test('should sort each category by path', () => {
    const base = [
      { path: 'b.ts', content: 'x\n' },
      { path: 'a.ts', content: 'x\n' },
    ];
    const on = [
      { path: 'd.ts', content: 'y\n' },
      { path: 'c.ts', content: 'y\n' },
      { path: 'b.ts', content: 'x\n' },
      { path: 'a.ts', content: 'x\n' },
    ];
    assert.deepEqual(classifyTrees(base, on), {
      added: ['c.ts', 'd.ts'],
      removed: [],
      changed: [],
      unchanged: ['a.ts', 'b.ts'],
    });
  });

  await t.test('should report identical trees as all unchanged', () => {
    assert.deepEqual(classifyTrees(baseline, baseline), {
      added: [],
      removed: [],
      changed: [],
      unchanged: ['app.ts', 'routes/login.ts', 'routes/token.ts'],
    });
  });
});

test('renderUnifiedDiff', async (t) => {
  await t.test('should return an empty string for identical trees', () => {
    assert.equal(renderUnifiedDiff(baseline, baseline, 'default-op', 'with-par'), '');
  });

  await t.test('should render a git unified diff labeled with the given tree names', () => {
    const patch = renderUnifiedDiff(
      [{ path: 'app.ts', content: 'line1\nline2\n' }],
      [{ path: 'app.ts', content: 'line1\nline2 changed\n' }],
      'default-op',
      'with-par',
    );
    const lines = patch.split('\n');
    assert.equal(lines[0], 'diff --git a/default-op/app.ts b/with-par/app.ts');
    // ハッシュ行(index)を挟んで --- / +++ / hunk が続く
    assert.equal(lines[2], '--- a/default-op/app.ts');
    assert.equal(lines[3], '+++ b/with-par/app.ts');
    assert.equal(lines[4], '@@ -1,2 +1,2 @@');
    assert.equal(lines[5], ' line1');
    assert.equal(lines[6], '-line2');
    assert.equal(lines[7], '+line2 changed');
  });

  await t.test('should render an added file with its full content', () => {
    const patch = renderUnifiedDiff(
      [],
      [{ path: 'routes/par.ts', content: 'par route\n' }],
      'default-op',
      'with-par',
    );
    const lines = patch.split('\n');
    assert.equal(lines[0], 'diff --git a/with-par/routes/par.ts b/with-par/routes/par.ts');
    assert.equal(lines[1], 'new file mode 100644');
    assert.equal(lines[3], '--- /dev/null');
    assert.equal(lines[4], '+++ b/with-par/routes/par.ts');
    assert.equal(lines[5], '@@ -0,0 +1 @@');
    assert.equal(lines[6], '+par route');
  });

  await t.test('should be deterministic across invocations', () => {
    const first = renderUnifiedDiff(baseline, enabled, 'default-op', 'with-par');
    const second = renderUnifiedDiff(baseline, enabled, 'default-op', 'with-par');
    assert.equal(first, second);
  });
});

test('diffStats', async (t) => {
  await t.test('should count files, insertions and deletions from a patch', () => {
    const patch = renderUnifiedDiff(baseline, enabled, 'default-op', 'with-par');
    assert.deepEqual(diffStats(patch), { files: 3, insertions: 2, deletions: 2 });
  });

  await t.test('should return zeros for an empty patch', () => {
    assert.deepEqual(diffStats(''), { files: 0, insertions: 0, deletions: 0 });
  });
});
