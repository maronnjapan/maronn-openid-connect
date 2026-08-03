import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  AUTO_CHANGESET_FILENAME,
  buildExperimentalPatchChangeset,
  collectChangedPathsSinceLastRelease,
  decideExperimentalChangeset,
  hasManualExperimentalChangeset,
  readVersionFromManifest,
  selectExperimentalSourceChanges,
  selectLastVersionBump,
} from './ensure-experimental-changeset.mjs';

describe('selectExperimentalSourceChanges', () => {
  it('should keep implementation files under packages/experimental/src', () => {
    assert.deepEqual(
      selectExperimentalSourceChanges([
        'packages/experimental/src/par/par-request.ts',
        'packages/experimental/src/token-exchange/index.ts',
      ]),
      ['packages/experimental/src/par/par-request.ts', 'packages/experimental/src/token-exchange/index.ts'],
    );
  });

  it('should drop paths outside packages/experimental/src', () => {
    assert.deepEqual(
      selectExperimentalSourceChanges([
        'packages/core/src/id-token.ts',
        'packages/experimental/README.md',
        'packages/experimental/package.json',
        'packages/experimental/src/par/store.ts',
      ]),
      ['packages/experimental/src/par/store.ts'],
    );
  });

  // テストだけの変更は dist に出ないため publish 対象にしない（tsconfig の exclude と同じ判定）
  it('should drop test files so that test-only changes do not trigger a release', () => {
    assert.deepEqual(
      selectExperimentalSourceChanges([
        'packages/experimental/src/par/par-request.test.ts',
        'packages/experimental/src/par/resolve-request-uri.spec.ts',
      ]),
      [],
    );
  });

  it('should drop empty lines produced by git output', () => {
    assert.deepEqual(selectExperimentalSourceChanges(['', 'packages/experimental/src/par/index.ts', '']), [
      'packages/experimental/src/par/index.ts',
    ]);
  });

  it('should return an empty array when nothing changed', () => {
    assert.deepEqual(selectExperimentalSourceChanges([]), []);
  });
});

describe('hasManualExperimentalChangeset', () => {
  it('should return true when a hand-written changeset bumps @maronn-oidc/experimental', () => {
    assert.equal(
      hasManualExperimentalChangeset([
        { file: 'a.md', bumps: { '@maronn-oidc/cli': 'patch' } },
        { file: 'experimental-par.md', bumps: { '@maronn-oidc/experimental': 'patch' } },
      ]),
      true,
    );
  });

  // 自動生成した changeset は書き直す対象なので「手書きがある」とは扱わない
  it('should return false when only the auto-generated changeset bumps experimental', () => {
    assert.equal(
      hasManualExperimentalChangeset([
        { file: AUTO_CHANGESET_FILENAME, bumps: { '@maronn-oidc/experimental': 'patch' } },
      ]),
      false,
    );
  });

  it('should return false when only other packages are bumped', () => {
    assert.equal(
      hasManualExperimentalChangeset([
        { file: 'a.md', bumps: { '@maronn-oidc/cli': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-oidc/core': 'patch' } },
      ]),
      false,
    );
  });

  it('should return false when there are no changesets', () => {
    assert.equal(hasManualExperimentalChangeset([]), false);
  });
});

describe('buildExperimentalPatchChangeset', () => {
  it('should declare a patch bump for @maronn-oidc/experimental and list the changed sources in sorted order', () => {
    const content = buildExperimentalPatchChangeset([
      'packages/experimental/src/token-exchange/token-exchange-request.ts',
      'packages/experimental/src/par/par-request.ts',
    ]);

    assert.equal(
      content,
      [
        '---',
        '"@maronn-oidc/experimental": patch',
        '---',
        '',
        '`packages/experimental/src` の変更をリリースする。experimental のバージョンは変更内容に関わらず patch を 1 つ上げるだけに固定しており、未リリースの変更が複数たまっている場合も 1 回の patch に吸収する。',
        '',
        'このリリースに含まれる変更:',
        '',
        '- packages/experimental/src/par/par-request.ts',
        '- packages/experimental/src/token-exchange/token-exchange-request.ts',
        '',
      ].join('\n'),
    );
  });
});

describe('decideExperimentalChangeset', () => {
  it('should create a patch changeset when experimental sources changed since the last release', () => {
    const decision = decideExperimentalChangeset({
      changedPaths: ['packages/experimental/src/par/par-request.ts'],
      changesets: [{ file: 'a.md', bumps: { '@maronn-oidc/cli': 'patch' } }],
    });

    assert.deepEqual(decision, {
      shouldCreate: true,
      reason:
        '未リリースの packages/experimental/src の変更が 1 件あるため、patch の changeset を .changeset/auto-experimental-patch.md に書き出す',
      content: buildExperimentalPatchChangeset(['packages/experimental/src/par/par-request.ts']),
    });
  });

  it('should not create a changeset when no experimental source changed', () => {
    const decision = decideExperimentalChangeset({
      changedPaths: ['packages/core/src/id-token.ts'],
      changesets: [],
    });

    assert.deepEqual(decision, {
      shouldCreate: false,
      reason: '未リリースの packages/experimental/src の変更がないため changeset を作成しない',
    });
  });

  it('should not create a changeset when only experimental tests changed', () => {
    const decision = decideExperimentalChangeset({
      changedPaths: ['packages/experimental/src/par/par-request.test.ts'],
      changesets: [],
    });

    assert.deepEqual(decision, {
      shouldCreate: false,
      reason: '未リリースの packages/experimental/src の変更がないため changeset を作成しない',
    });
  });

  // Version Packages PR のマージ忘れで複数機能がたまっても、changeset は 1 本のまま patch 1 回に収める。
  // 生成済みの changeset は毎回上書きし、たまった変更をすべて載せた状態に保つ。
  it('should rewrite its own changeset so that every accumulated change is listed in one patch release', () => {
    const changedPaths = [
      'packages/experimental/src/par/par-request.ts',
      'packages/experimental/src/token-exchange/token-exchange-request.ts',
    ];

    const decision = decideExperimentalChangeset({
      changedPaths,
      changesets: [{ file: AUTO_CHANGESET_FILENAME, bumps: { '@maronn-oidc/experimental': 'patch' } }],
    });

    assert.deepEqual(decision, {
      shouldCreate: true,
      reason:
        '未リリースの packages/experimental/src の変更が 2 件あるため、patch の changeset を .changeset/auto-experimental-patch.md に書き出す',
      content: buildExperimentalPatchChangeset(changedPaths),
    });
  });

  it('should not create a changeset when a hand-written changeset already releases experimental', () => {
    const decision = decideExperimentalChangeset({
      changedPaths: ['packages/experimental/src/par/par-request.ts'],
      changesets: [{ file: 'experimental-par.md', bumps: { '@maronn-oidc/experimental': 'patch' } }],
    });

    assert.deepEqual(decision, {
      shouldCreate: false,
      reason: '手書きの experimental changeset が未リリースで残っているため changeset を作成しない',
    });
  });
});

describe('readVersionFromManifest', () => {
  it('should read the version field from a package.json content', () => {
    assert.equal(readVersionFromManifest('{"name":"@maronn-oidc/experimental","version":"0.0.3"}'), '0.0.3');
  });

  it('should return null when the content is not valid JSON', () => {
    assert.equal(readVersionFromManifest('not json'), null);
  });

  it('should return null when the manifest has no version field', () => {
    assert.equal(readVersionFromManifest('{"name":"@maronn-oidc/experimental"}'), null);
  });
});

describe('selectLastVersionBump', () => {
  it('should select the newest commit whose version differs from every parent', () => {
    assert.deepEqual(
      selectLastVersionBump([
        { commit: 'c3', version: '0.0.3', parentVersions: ['0.0.2'] },
        { commit: 'c2', version: '0.0.2', parentVersions: ['0.0.1'] },
      ]),
      { commit: 'c3', version: '0.0.3' },
    );
  });

  // Version Packages PR のマージコミットは、リリースブランチ側の親から version を引き継ぐだけで
  // 自分では version を上げていない。基準点は version を確定したコミットそのものにする。
  it('should skip a merge commit that inherits its version from one of its parents', () => {
    assert.deepEqual(
      selectLastVersionBump([
        { commit: 'merge', version: '0.0.3', parentVersions: ['0.0.2', '0.0.3'] },
        { commit: 'version-packages', version: '0.0.3', parentVersions: ['0.0.2'] },
      ]),
      { commit: 'version-packages', version: '0.0.3' },
    );
  });

  it('should skip commits that only touched the manifest without changing its version', () => {
    assert.deepEqual(
      selectLastVersionBump([
        { commit: 'add-keyword', version: '0.0.2', parentVersions: ['0.0.2'] },
        { commit: 'version-packages', version: '0.0.2', parentVersions: ['0.0.1'] },
      ]),
      { commit: 'version-packages', version: '0.0.2' },
    );
  });

  it('should treat the commit that introduced the manifest as a version bump', () => {
    assert.deepEqual(
      selectLastVersionBump([{ commit: 'initial', version: '0.0.1', parentVersions: [null] }]),
      { commit: 'initial', version: '0.0.1' },
    );
  });

  it('should skip commits whose manifest version cannot be read', () => {
    assert.deepEqual(
      selectLastVersionBump([
        { commit: 'deleted', version: null, parentVersions: ['0.0.2'] },
        { commit: 'version-packages', version: '0.0.2', parentVersions: ['0.0.1'] },
      ]),
      { commit: 'version-packages', version: '0.0.2' },
    );
  });

  it('should return null when there is no candidate', () => {
    assert.equal(selectLastVersionBump([]), null);
  });
});

// リリース基準点の判定は git の履歴そのものに依存するため、実際のリポジトリを組み立てて検証する。
// 「Version Packages のマージ直後に未リリース変更ゼロと判定されること」がこのスクリプトの要であり、
// ここが崩れると changeset が作られ続けて publish 段階に到達しない（= Version Packages PR を
// マージしても publish されない）。
describe('collectChangedPathsSinceLastRelease', () => {
  const repositories = [];

  after(() => {
    for (const repository of repositories) rmSync(repository, { recursive: true, force: true });
  });

  function git(repository, args) {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function write(repository, path, content) {
    const absolute = join(repository, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }

  function writeManifest(repository, version) {
    write(
      repository,
      'packages/experimental/package.json',
      `${JSON.stringify({ name: '@maronn-oidc/experimental', version }, null, 2)}\n`,
    );
  }

  function commit(repository, message) {
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', message]);
  }

  /**
   * publish 済み experimental が 1 つあり、そのあと src を 1 ファイル変更し、
   * その変更を Version Packages PR で 0.0.2 に確定してマージし終えた状態のリポジトリを作る。
   */
  function createReleasedRepository() {
    const repository = mkdtempSync(join(tmpdir(), 'maronn-ensure-changeset-'));
    repositories.push(repository);

    git(repository, ['init', '--initial-branch=main']);
    git(repository, ['config', 'user.email', 'test@example.com']);
    git(repository, ['config', 'user.name', 'test']);

    writeManifest(repository, '0.0.1');
    write(repository, 'packages/experimental/src/par/index.ts', 'export const par = 1;\n');
    commit(repository, 'feat(experimental): PAR を追加する');

    write(repository, 'packages/experimental/src/par/index.ts', 'export const par = 2;\n');
    commit(repository, 'fix(experimental): PAR を修正する');

    git(repository, ['checkout', '-b', 'changeset-release/main']);
    writeManifest(repository, '0.0.2');
    commit(repository, 'Version Packages');

    git(repository, ['checkout', 'main']);
    git(repository, ['merge', '--no-ff', 'changeset-release/main', '-m', 'Merge pull request #1']);

    return repository;
  }

  it('should report no unreleased source change right after the Version Packages PR is merged', () => {
    const repository = createReleasedRepository();

    assert.deepEqual(selectExperimentalSourceChanges(collectChangedPathsSinceLastRelease(repository).paths), []);
  });

  it('should use the commit that fixed the version as the comparison base', () => {
    const repository = createReleasedRepository();

    assert.equal(
      collectChangedPathsSinceLastRelease(repository).base,
      `${git(repository, ['rev-parse', 'HEAD^2']).trim()} (version 0.0.2)`,
    );
  });

  it('should report source changes pushed after the Version Packages PR was merged', () => {
    const repository = createReleasedRepository();

    write(repository, 'packages/experimental/src/token-exchange/index.ts', 'export const exchange = 1;\n');
    commit(repository, 'feat(experimental): Token Exchange を追加する');

    assert.deepEqual(selectExperimentalSourceChanges(collectChangedPathsSinceLastRelease(repository).paths), [
      'packages/experimental/src/token-exchange/index.ts',
    ]);
  });

  // publish が失敗してタグが打たれなかった場合でも、version が確定している以上その変更は
  // 「次に publish されるバージョンに載っている」ので、changeset を作り直してはいけない。
  // 作り直すと version 段階に戻され、失敗した publish が二度と再試行されない。
  it('should not report released changes again when the publish left no release tag behind', () => {
    const repository = createReleasedRepository();

    assert.deepEqual(git(repository, ['tag', '--list']), '');
    assert.deepEqual(selectExperimentalSourceChanges(collectChangedPathsSinceLastRelease(repository).paths), []);
  });

  it('should treat every tracked source as unreleased when the manifest has no history', () => {
    const repository = mkdtempSync(join(tmpdir(), 'maronn-ensure-changeset-'));
    repositories.push(repository);

    git(repository, ['init', '--initial-branch=main']);
    git(repository, ['config', 'user.email', 'test@example.com']);
    git(repository, ['config', 'user.name', 'test']);

    write(repository, 'packages/experimental/src/par/index.ts', 'export const par = 1;\n');
    commit(repository, 'feat(experimental): PAR を追加する');

    const collected = collectChangedPathsSinceLastRelease(repository);

    assert.equal(collected.base, '（experimental の version を確定したコミットなし: 全ソースを未リリース扱い）');
    assert.deepEqual(selectExperimentalSourceChanges(collected.paths), ['packages/experimental/src/par/index.ts']);
  });
});
