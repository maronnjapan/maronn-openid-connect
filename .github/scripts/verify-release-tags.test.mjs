import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertReleaseTagsArePushed,
  parseRemoteTags,
  selectUnpushedReleaseTags,
} from './verify-release-tags.mjs';

const packages = [
  { name: '@maronn-openid-connect/core', version: '0.11.0' },
  { name: '@maronn-openid-connect/cli', version: '0.16.0' },
];

describe('parseRemoteTags', () => {
  it('should read the tag names from git ls-remote --tags --refs', () => {
    assert.deepEqual(
      parseRemoteTags(
        '169575a47092f469a8abb19d0de4d81fe5234761\trefs/tags/@maronn-openid-connect/core@0.2.0\n' +
          '169575a47092f469a8abb19d0de4d81fe5234761\trefs/tags/@maronn-openid-connect/cli@0.4.0\n',
      ),
      ['@maronn-openid-connect/core@0.2.0', '@maronn-openid-connect/cli@0.4.0'],
    );
  });

  it('should return nothing when origin has no tags', () => {
    assert.deepEqual(parseRemoteTags(''), []);
  });
});

describe('selectUnpushedReleaseTags', () => {
  it('should select nothing when changesets/action pushed every tag changeset publish created', () => {
    const tags = ['@maronn-openid-connect/core@0.11.0', '@maronn-openid-connect/cli@0.16.0'];

    assert.deepEqual(selectUnpushedReleaseTags({ packages, localTagsAtHead: tags, remoteTags: tags }), []);
  });

  // changesets/action@v1 は @changesets/cli 3 系の publish を検出できず、changeset publish が
  // ローカルに打ったタグを push しないまま成功で終わっていた（2026-09-03〜10-24）。
  it('should select the tags changeset publish created but changesets/action did not push', () => {
    assert.deepEqual(
      selectUnpushedReleaseTags({
        packages,
        localTagsAtHead: ['@maronn-openid-connect/core@0.11.0', '@maronn-openid-connect/cli@0.16.0'],
        remoteTags: ['@maronn-openid-connect/core@0.2.0', '@maronn-openid-connect/cli@0.4.0'],
      }),
      ['@maronn-openid-connect/core@0.11.0', '@maronn-openid-connect/cli@0.16.0'],
    );
  });

  // 2026-09-03〜10-24 にタグ無しで publish されたバージョンは origin にタグが無いが、
  // この run の changeset publish が publish したものではないので HEAD にもタグが無い。
  // ここで落とすと、それより後のすべての publish 段階の run が赤くなる。
  it('should ignore versions on main that this run did not publish', () => {
    assert.deepEqual(selectUnpushedReleaseTags({ packages, localTagsAtHead: [], remoteTags: [] }), []);
  });

  // 同じ commit の re-run では、初回に push したタグを checkout が持ってくる。
  it('should accept tags that a previous attempt on the same commit already pushed', () => {
    assert.deepEqual(
      selectUnpushedReleaseTags({
        packages: [{ name: '@maronn-openid-connect/core', version: '0.11.0' }],
        localTagsAtHead: ['@maronn-openid-connect/core@0.11.0'],
        remoteTags: ['@maronn-openid-connect/core@0.2.0', '@maronn-openid-connect/core@0.11.0'],
      }),
      [],
    );
  });

  it('should ignore tags at HEAD that do not name a main version of a publishable package', () => {
    assert.deepEqual(
      selectUnpushedReleaseTags({
        packages,
        localTagsAtHead: ['@maronn-openid-connect/core@0.10.0', 'v1.0.0'],
        remoteTags: [],
      }),
      [],
    );
  });
});

describe('assertReleaseTagsArePushed', () => {
  it('should pass when every tag is on origin', () => {
    assert.doesNotThrow(() => assertReleaseTagsArePushed([]));
  });

  it('should throw naming the tags that changesets/action did not push', () => {
    assert.throws(
      () => assertReleaseTagsArePushed(['@maronn-openid-connect/core@0.11.0']),
      /changeset publish が作ったタグが origin にありません: @maronn-openid-connect\/core@0\.11\.0\n/,
    );
  });
});
