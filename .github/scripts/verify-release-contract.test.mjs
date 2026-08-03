import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCoreBreakingChangeReleasesExperimental,
  assertExperimentalCorePeerDependencyShape,
  assertExperimentalReleasesAreAlwaysPatch,
  parseChangesetBumps,
} from './verify-release-contract.mjs';

describe('parseChangesetBumps', () => {
  it('should read every package bump from the frontmatter', () => {
    const content = [
      '---',
      '"@maronn-oidc/core": minor',
      '"@maronn-oidc/experimental": patch',
      '---',
      '',
      'some description',
      '',
    ].join('\n');

    assert.deepEqual(parseChangesetBumps(content), {
      '@maronn-oidc/core': 'minor',
      '@maronn-oidc/experimental': 'patch',
    });
  });

  it('should accept single quotes around the package name', () => {
    const content = ['---', "'@maronn-oidc/core': patch", '---', '', 'body', ''].join('\n');

    assert.deepEqual(parseChangesetBumps(content), { '@maronn-oidc/core': 'patch' });
  });

  it('should return an empty object for a file without frontmatter', () => {
    assert.deepEqual(parseChangesetBumps('# Changesets\n\nread me\n'), {});
  });

  it('should ignore bump-like lines that appear after the frontmatter', () => {
    const content = [
      '---',
      '"@maronn-oidc/core": patch',
      '---',
      '',
      '"@maronn-oidc/experimental": major は本文中の例示なので無視する',
      '',
    ].join('\n');

    assert.deepEqual(parseChangesetBumps(content), { '@maronn-oidc/core': 'patch' });
  });
});

describe('assertCoreBreakingChangeReleasesExperimental', () => {
  it('should accept a core patch release without an experimental release', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-oidc/core': 'patch' } },
      ]);
    });
  });

  it('should accept an experimental only release', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-oidc/experimental': 'minor' } },
      ]);
    });
  });

  it('should accept a core minor release that also releases experimental', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-oidc/core': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-oidc/experimental': 'patch' } },
      ]);
    });
  });

  it('should reject a core minor release without an experimental release', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesExperimental([
          { file: 'a.md', bumps: { '@maronn-oidc/core': 'minor' } },
        ]),
      new Error(
        '@maronn-oidc/core を minor 以上で上げる changeset (a.md) がありますが、' +
          '@maronn-oidc/experimental の changeset がありません。' +
          'experimental は core を広い peer range で参照しており、公開済みの古い experimental が' +
          '新しい core をそのまま受け入れてしまうため、core の minor / major では' +
          'experimental も同時にリリースして最新 core との組み合わせを保証してください。',
      ),
    );
  });

  it('should reject a core major release without an experimental release', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesExperimental([
          { file: 'core-major.md', bumps: { '@maronn-oidc/core': 'major' } },
        ]),
      /core-major\.md/,
    );
  });

  it('should list every offending changeset file when several exist', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesExperimental([
          { file: 'a.md', bumps: { '@maronn-oidc/core': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-oidc/core': 'major' } },
        ]),
      /\(a\.md, b\.md\)/,
    );
  });

  it('should accept a release that touches neither package', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-oidc/cli': 'minor' } },
      ]);
    });
  });
});

describe('assertExperimentalCorePeerDependencyShape', () => {
  it('should accept core declared as a peer dependency and linked for local development', () => {
    assert.doesNotThrow(() => {
      assertExperimentalCorePeerDependencyShape({
        peerDependencies: { '@maronn-oidc/core': '>=0.0.1 <1.0.0' },
        devDependencies: { '@maronn-oidc/core': 'workspace:*' },
      });
    });
  });

  it('should reject core declared as a runtime dependency', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          dependencies: { '@maronn-oidc/core': '0.0.1' },
          peerDependencies: { '@maronn-oidc/core': '>=0.0.1 <1.0.0' },
          devDependencies: { '@maronn-oidc/core': 'workspace:*' },
        }),
      new Error(
        '@maronn-oidc/experimental は @maronn-oidc/core を dependencies に持ってはいけません。' +
          'core が二重にインストールされると instanceof 判定が静かに false になります。',
      ),
    );
  });

  it('should reject a missing core peer dependency', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          devDependencies: { '@maronn-oidc/core': 'workspace:*' },
        }),
      new Error(
        '@maronn-oidc/experimental は @maronn-oidc/core を peerDependencies に宣言してください。',
      ),
    );
  });

  it('should reject a missing workspace link for local development', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          peerDependencies: { '@maronn-oidc/core': '>=0.0.1 <1.0.0' },
        }),
      new Error(
        '@maronn-oidc/experimental は @maronn-oidc/core を devDependencies の workspace:* で' +
          '参照してください。ローカル開発とテストが registry の core を引いてしまいます。',
      ),
    );
  });

  it('should reject a devDependency that does not use the workspace protocol', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          peerDependencies: { '@maronn-oidc/core': '>=0.0.1 <1.0.0' },
          devDependencies: { '@maronn-oidc/core': '^0.0.1' },
        }),
      /workspace:\*/,
    );
  });
});

describe('assertExperimentalReleasesAreAlwaysPatch', () => {
  it('should accept a patch bump for experimental', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([
        { file: 'a.md', bumps: { '@maronn-oidc/experimental': 'patch' } },
      ]);
    });
  });

  it('should accept changesets that do not release experimental', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([
        { file: 'a.md', bumps: { '@maronn-oidc/cli': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-oidc/core': 'major' } },
      ]);
    });
  });

  it('should accept an empty changeset list', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([]);
    });
  });

  it('should reject a minor bump for experimental', () => {
    assert.throws(
      () =>
        assertExperimentalReleasesAreAlwaysPatch([
          { file: 'experimental-par.md', bumps: { '@maronn-oidc/experimental': 'minor' } },
        ]),
      /experimental-par\.md \(minor\)/,
    );
  });

  it('should reject a major bump for experimental', () => {
    assert.throws(
      () =>
        assertExperimentalReleasesAreAlwaysPatch([
          { file: 'breaking.md', bumps: { '@maronn-oidc/experimental': 'major' } },
        ]),
      /breaking\.md \(major\)/,
    );
  });
});
