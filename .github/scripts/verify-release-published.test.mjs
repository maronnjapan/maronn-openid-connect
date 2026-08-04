import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertMainVersionsArePublished,
  parsePublishedVersions,
  selectPendingChangesets,
  selectUnpublishedPackages,
} from './verify-release-published.mjs';

describe('selectPendingChangesets', () => {
  it('should select changeset markdown files', () => {
    assert.deepEqual(selectPendingChangesets(['.changeset/README.md', '.changeset/brave-pans-shave.md']), [
      '.changeset/brave-pans-shave.md',
    ]);
  });

  it('should select nothing when only the changeset scaffolding is committed', () => {
    assert.deepEqual(selectPendingChangesets(['.changeset/README.md', '.changeset/config.json']), []);
  });

  it('should select nothing when the directory is absent', () => {
    assert.deepEqual(selectPendingChangesets([]), []);
  });
});

describe('parsePublishedVersions', () => {
  it('should list every version key of the registry document', () => {
    assert.deepEqual(parsePublishedVersions({ versions: { '0.0.1': {}, '0.0.2': {} } }), ['0.0.1', '0.0.2']);
  });

  it('should return an empty list when the package is not on the registry yet', () => {
    assert.deepEqual(parsePublishedVersions({ error: 'Not found' }), []);
  });

  it('should return an empty list when the document has no versions field', () => {
    assert.deepEqual(parsePublishedVersions({}), []);
  });
});

describe('selectUnpublishedPackages', () => {
  it('should select packages whose main version is missing from the registry', () => {
    assert.deepEqual(
      selectUnpublishedPackages(
        [
          { name: '@maronn-openid-connect/core', version: '0.1.0' },
          { name: '@maronn-openid-connect/cli', version: '0.1.0' },
        ],
        { '@maronn-openid-connect/core': ['0.0.1'], '@maronn-openid-connect/cli': ['0.0.1', '0.1.0'] },
      ),
      [{ name: '@maronn-openid-connect/core', version: '0.1.0', latestPublishedVersion: '0.0.1' }],
    );
  });

  it('should select nothing when every main version is on the registry', () => {
    assert.deepEqual(
      selectUnpublishedPackages([{ name: '@maronn-openid-connect/core', version: '0.1.0' }], {
        '@maronn-openid-connect/core': ['0.0.1', '0.1.0'],
      }),
      [],
    );
  });

  // 手動 publish などで registry のほうが先に進んでいる状態は、publish 漏れではないので通す。
  it('should select nothing when the registry has newer versions than main', () => {
    assert.deepEqual(
      selectUnpublishedPackages([{ name: '@maronn-openid-connect/core', version: '0.1.0' }], {
        '@maronn-openid-connect/core': ['0.1.0', '0.2.0'],
      }),
      [],
    );
  });

  // 初回 publish は Trusted Publishing の chicken-and-egg で手動になる（RELEASE.md 参照）。
  // publish 実績が無い package を未 publish 扱いにすると、追加した時点で Release が赤くなってしまう。
  it('should skip packages that have never been published', () => {
    assert.deepEqual(
      selectUnpublishedPackages([{ name: '@maronn-openid-connect/new', version: '0.0.1' }], { '@maronn-openid-connect/new': [] }),
      [],
    );
  });

  it('should skip packages that are missing from the registry lookup', () => {
    assert.deepEqual(selectUnpublishedPackages([{ name: '@maronn-openid-connect/new', version: '0.0.1' }], {}), []);
  });
});

describe('assertMainVersionsArePublished', () => {
  it('should pass when every publishable package version exists on the registry', () => {
    assert.doesNotThrow(() =>
      assertMainVersionsArePublished({
        packages: [{ name: '@maronn-openid-connect/core', version: '0.1.0' }],
        publishedVersionsByName: { '@maronn-openid-connect/core': ['0.1.0'] },
        pendingChangesets: [],
      }),
    );
  });

  it('should throw naming the package and both versions when a release never reached npm', () => {
    assert.throws(
      () =>
        assertMainVersionsArePublished({
          packages: [{ name: '@maronn-openid-connect/core', version: '0.1.0' }],
          publishedVersionsByName: { '@maronn-openid-connect/core': ['0.0.1'] },
          pendingChangesets: [],
        }),
      {
        message:
          'main のバージョンが npm に出ていません: @maronn-openid-connect/core@0.1.0 (npm の最新は 0.0.1)\n' +
          'main に未消化の changeset は無いので、この push は publish 段階に入るはずでした。\n' +
          'release job の "Ensure experimental release changeset" が changeset を作り直して' +
          ' version 段階へ入り直していないかを確認してください' +
          '（RELEASE.md「publish に到達したことを検証する」）。',
      },
    );
  });

  it('should list every unpublished package at once', () => {
    assert.throws(
      () =>
        assertMainVersionsArePublished({
          packages: [
            { name: '@maronn-openid-connect/core', version: '0.1.0' },
            { name: '@maronn-openid-connect/cli', version: '0.1.0' },
          ],
          publishedVersionsByName: { '@maronn-openid-connect/core': ['0.0.1'], '@maronn-openid-connect/cli': ['0.0.1'] },
          pendingChangesets: [],
        }),
      /@maronn-openid-connect\/core@0\.1\.0 \(npm の最新は 0\.0\.1\), @maronn-openid-connect\/cli@0\.1\.0 \(npm の最新は 0\.0\.1\)/,
    );
  });

  // main に changeset が残っている間は version 段階が正しい挙動で、publish は次の
  // Version Packages PR のマージまで起きない。Version Packages PR のマージと changeset の
  // 追加が競合すると、バージョンだけ先に進んだ状態が一時的に生まれるため、ここで弾かない。
  it('should pass while main still carries an unconsumed changeset', () => {
    assert.doesNotThrow(() =>
      assertMainVersionsArePublished({
        packages: [{ name: '@maronn-openid-connect/core', version: '0.1.0' }],
        publishedVersionsByName: { '@maronn-openid-connect/core': ['0.0.1'] },
        pendingChangesets: ['.changeset/brave-pans-shave.md'],
      }),
    );
  });
});
