import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildExperimentalPatchChangeset,
  decideExperimentalChangeset,
  hasPendingExperimentalChangeset,
  selectExperimentalSourceChanges,
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

describe('hasPendingExperimentalChangeset', () => {
  it('should return true when a changeset bumps @maronn-oidc/experimental', () => {
    assert.equal(
      hasPendingExperimentalChangeset([
        { file: 'a.md', bumps: { '@maronn-oidc/cli': 'patch' } },
        { file: 'b.md', bumps: { '@maronn-oidc/experimental': 'patch' } },
      ]),
      true,
    );
  });

  it('should return false when only other packages are bumped', () => {
    assert.equal(
      hasPendingExperimentalChangeset([
        { file: 'a.md', bumps: { '@maronn-oidc/cli': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-oidc/core': 'patch' } },
      ]),
      false,
    );
  });

  it('should return false when there are no changesets', () => {
    assert.equal(hasPendingExperimentalChangeset([]), false);
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
        '未リリースの packages/experimental/src の変更が 1 件あり、experimental を上げる changeset がないため patch の changeset を作成する',
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

  // Version Packages PR のマージ忘れで複数機能がたまっても、changeset は 1 本のまま patch 1 回に収める
  it('should not create a second changeset when a pending changeset already releases experimental', () => {
    const decision = decideExperimentalChangeset({
      changedPaths: [
        'packages/experimental/src/par/par-request.ts',
        'packages/experimental/src/token-exchange/token-exchange-request.ts',
      ],
      changesets: [{ file: 'auto-experimental-patch.md', bumps: { '@maronn-oidc/experimental': 'patch' } }],
    });

    assert.deepEqual(decision, {
      shouldCreate: false,
      reason: '未リリースの experimental を上げる changeset が既にあるため changeset を作成しない',
    });
  });
});
