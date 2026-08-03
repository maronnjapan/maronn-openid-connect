import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertMainVersionsArePublished,
  parsePublishedVersions,
  selectUnpublishedPackages,
} from './verify-release-published.mjs';

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
          { name: '@maronn-oidc/core', version: '0.1.0' },
          { name: '@maronn-oidc/cli', version: '0.1.0' },
        ],
        { '@maronn-oidc/core': ['0.0.1'], '@maronn-oidc/cli': ['0.0.1', '0.1.0'] },
      ),
      [{ name: '@maronn-oidc/core', version: '0.1.0', latestPublishedVersion: '0.0.1' }],
    );
  });

  it('should select nothing when every main version is on the registry', () => {
    assert.deepEqual(
      selectUnpublishedPackages([{ name: '@maronn-oidc/core', version: '0.1.0' }], {
        '@maronn-oidc/core': ['0.0.1', '0.1.0'],
      }),
      [],
    );
  });

  // 手動 publish などで registry のほうが先に進んでいる状態は、publish 漏れではないので通す。
  it('should select nothing when the registry has newer versions than main', () => {
    assert.deepEqual(
      selectUnpublishedPackages([{ name: '@maronn-oidc/core', version: '0.1.0' }], {
        '@maronn-oidc/core': ['0.1.0', '0.2.0'],
      }),
      [],
    );
  });

  // 初回 publish は Trusted Publishing の chicken-and-egg で手動になる（RELEASE.md 参照）。
  // publish 実績が無い package を未 publish 扱いにすると、追加した時点で Release が赤くなってしまう。
  it('should skip packages that have never been published', () => {
    assert.deepEqual(
      selectUnpublishedPackages([{ name: '@maronn-oidc/new', version: '0.0.1' }], { '@maronn-oidc/new': [] }),
      [],
    );
  });

  it('should skip packages that are missing from the registry lookup', () => {
    assert.deepEqual(selectUnpublishedPackages([{ name: '@maronn-oidc/new', version: '0.0.1' }], {}), []);
  });
});

describe('assertMainVersionsArePublished', () => {
  it('should pass when every publishable package version exists on the registry', () => {
    assert.doesNotThrow(() =>
      assertMainVersionsArePublished([{ name: '@maronn-oidc/core', version: '0.1.0' }], {
        '@maronn-oidc/core': ['0.1.0'],
      }),
    );
  });

  it('should throw naming the package and both versions when a release never reached npm', () => {
    assert.throws(
      () =>
        assertMainVersionsArePublished([{ name: '@maronn-oidc/core', version: '0.1.0' }], {
          '@maronn-oidc/core': ['0.0.1'],
        }),
      {
        message:
          'main のバージョンが npm に出ていません: @maronn-oidc/core@0.1.0 (npm の最新は 0.0.1)\n' +
          'Version Packages PR がマージされてバージョンが確定したのに publish 段階へ到達していません。\n' +
          '未消化の changeset が残り続けて changesets/action が version 段階に入り直していないかを' +
          '確認してください（RELEASE.md「publish に到達したことを検証する」）。',
      },
    );
  });

  it('should list every unpublished package at once', () => {
    assert.throws(
      () =>
        assertMainVersionsArePublished(
          [
            { name: '@maronn-oidc/core', version: '0.1.0' },
            { name: '@maronn-oidc/cli', version: '0.1.0' },
          ],
          { '@maronn-oidc/core': ['0.0.1'], '@maronn-oidc/cli': ['0.0.1'] },
        ),
      /@maronn-oidc\/core@0\.1\.0 \(npm の最新は 0\.0\.1\), @maronn-oidc\/cli@0\.1\.0 \(npm の最新は 0\.0\.1\)/,
    );
  });
});
