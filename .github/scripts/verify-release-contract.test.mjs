import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCoreBreakingChangeReleasesExperimental,
  assertExperimentalCorePeerDependencyShape,
  assertExperimentalCorePeerRangeCoversNextCore,
  assertExperimentalReleasesAreAlwaysPatch,
  assertPrivatePackagesAreNotVersioned,
  computeNextVersion,
  parseChangesetBumps,
  parseMinimumCoreVersion,
  resolveNextCoreVersion,
} from './verify-release-contract.mjs';

describe('parseChangesetBumps', () => {
  it('should read every package bump from the frontmatter', () => {
    const content = [
      '---',
      '"@maronn-openid-connect/core": minor',
      '"@maronn-openid-connect/experimental": patch',
      '---',
      '',
      'some description',
      '',
    ].join('\n');

    assert.deepEqual(parseChangesetBumps(content), {
      '@maronn-openid-connect/core': 'minor',
      '@maronn-openid-connect/experimental': 'patch',
    });
  });

  it('should accept single quotes around the package name', () => {
    const content = ['---', "'@maronn-openid-connect/core': patch", '---', '', 'body', ''].join('\n');

    assert.deepEqual(parseChangesetBumps(content), { '@maronn-openid-connect/core': 'patch' });
  });

  it('should return an empty object for a file without frontmatter', () => {
    assert.deepEqual(parseChangesetBumps('# Changesets\n\nread me\n'), {});
  });

  it('should ignore bump-like lines that appear after the frontmatter', () => {
    const content = [
      '---',
      '"@maronn-openid-connect/core": patch',
      '---',
      '',
      '"@maronn-openid-connect/experimental": major は本文中の例示なので無視する',
      '',
    ].join('\n');

    assert.deepEqual(parseChangesetBumps(content), { '@maronn-openid-connect/core': 'patch' });
  });
});

describe('assertCoreBreakingChangeReleasesExperimental', () => {
  it('should accept a core patch release without an experimental release', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'patch' } },
      ]);
    });
  });

  it('should accept an experimental only release', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-openid-connect/experimental': 'minor' } },
      ]);
    });
  });

  it('should accept a core minor release that also releases experimental', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-openid-connect/experimental': 'patch' } },
      ]);
    });
  });

  it('should reject a core minor release without an experimental release', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesExperimental([
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
        ]),
      new Error(
        '@maronn-openid-connect/core を minor 以上で上げる changeset (a.md) がありますが、' +
          '@maronn-openid-connect/experimental の changeset がありません。' +
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
          { file: 'core-major.md', bumps: { '@maronn-openid-connect/core': 'major' } },
        ]),
      /core-major\.md/,
    );
  });

  it('should list every offending changeset file when several exist', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesExperimental([
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-openid-connect/core': 'major' } },
        ]),
      /\(a\.md, b\.md\)/,
    );
  });

  it('should accept a release that touches neither package', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesExperimental([
        { file: 'a.md', bumps: { '@maronn-openid-connect/cli': 'minor' } },
      ]);
    });
  });
});

describe('assertExperimentalCorePeerDependencyShape', () => {
  it('should accept core declared as a peer dependency and linked for local development', () => {
    assert.doesNotThrow(() => {
      assertExperimentalCorePeerDependencyShape({
        peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
        devDependencies: { '@maronn-openid-connect/core': 'workspace:*' },
      });
    });
  });

  it('should reject core declared as a runtime dependency', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          dependencies: { '@maronn-openid-connect/core': '0.0.1' },
          peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
          devDependencies: { '@maronn-openid-connect/core': 'workspace:*' },
        }),
      new Error(
        '@maronn-openid-connect/experimental は @maronn-openid-connect/core を dependencies に持ってはいけません。' +
          'core が二重にインストールされると instanceof 判定が静かに false になります。',
      ),
    );
  });

  it('should reject a missing core peer dependency', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          devDependencies: { '@maronn-openid-connect/core': 'workspace:*' },
        }),
      new Error(
        '@maronn-openid-connect/experimental は @maronn-openid-connect/core を peerDependencies に宣言してください。',
      ),
    );
  });

  it('should reject a missing workspace link for local development', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
        }),
      new Error(
        '@maronn-openid-connect/experimental は @maronn-openid-connect/core を devDependencies の workspace:* で' +
          '参照してください。ローカル開発とテストが registry の core を引いてしまいます。',
      ),
    );
  });

  it('should reject a devDependency that does not use the workspace protocol', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerDependencyShape({
          peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
          devDependencies: { '@maronn-openid-connect/core': '^0.0.1' },
        }),
      /workspace:\*/,
    );
  });
});

describe('assertExperimentalReleasesAreAlwaysPatch', () => {
  it('should accept a patch bump for experimental', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([
        { file: 'a.md', bumps: { '@maronn-openid-connect/experimental': 'patch' } },
      ]);
    });
  });

  it('should accept changesets that do not release experimental', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([
        { file: 'a.md', bumps: { '@maronn-openid-connect/cli': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-openid-connect/core': 'major' } },
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
          { file: 'experimental-par.md', bumps: { '@maronn-openid-connect/experimental': 'minor' } },
        ]),
      /experimental-par\.md \(minor\)/,
    );
  });

  it('should reject a major bump for experimental', () => {
    assert.throws(
      () =>
        assertExperimentalReleasesAreAlwaysPatch([
          { file: 'breaking.md', bumps: { '@maronn-openid-connect/experimental': 'major' } },
        ]),
      /breaking\.md \(major\)/,
    );
  });
});

describe('parseMinimumCoreVersion', () => {
  it('should read the lower bound from a range with an upper bound', () => {
    assert.equal(parseMinimumCoreVersion('>=0.1.0 <1.0.0'), '0.1.0');
  });

  it('should read the lower bound from a range without an upper bound', () => {
    assert.equal(parseMinimumCoreVersion('>=0.2.3'), '0.2.3');
  });

  it('should tolerate extra whitespace around the comparator', () => {
    assert.equal(parseMinimumCoreVersion('  >= 1.2.3   <2.0.0 '), '1.2.3');
  });

  it('should return null for a caret range', () => {
    assert.equal(parseMinimumCoreVersion('^0.1.0'), null);
  });

  it('should return null for a wildcard range', () => {
    assert.equal(parseMinimumCoreVersion('*'), null);
  });
});

describe('computeNextVersion', () => {
  it('should raise the patch segment for a patch bump', () => {
    assert.equal(computeNextVersion('0.1.0', 'patch'), '0.1.1');
  });

  it('should raise the minor segment and reset patch for a minor bump', () => {
    assert.equal(computeNextVersion('0.0.1', 'minor'), '0.1.0');
  });

  it('should raise the major segment and reset minor and patch for a major bump', () => {
    assert.equal(computeNextVersion('0.1.2', 'major'), '1.0.0');
  });

  it('should keep the version unchanged when there is no bump', () => {
    assert.equal(computeNextVersion('0.1.0', undefined), '0.1.0');
  });
});

describe('resolveNextCoreVersion', () => {
  it('should return the current version when no changeset releases core', () => {
    assert.equal(
      resolveNextCoreVersion('0.1.0', [{ file: 'a.md', bumps: { '@maronn-openid-connect/cli': 'minor' } }]),
      '0.1.0',
    );
  });

  it('should apply the pending core bump', () => {
    assert.equal(
      resolveNextCoreVersion('0.0.1', [{ file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } }]),
      '0.1.0',
    );
  });

  it('should apply the largest pending core bump when several changesets release core', () => {
    assert.equal(
      resolveNextCoreVersion('0.0.1', [
        { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'patch' } },
        { file: 'b.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
        { file: 'c.md', bumps: { '@maronn-openid-connect/core': 'patch' } },
      ]),
      '0.1.0',
    );
  });
});

describe('assertExperimentalCorePeerRangeCoversNextCore', () => {
  it('should accept a lower bound equal to the next core version', () => {
    assert.doesNotThrow(() => {
      assertExperimentalCorePeerRangeCoversNextCore(
        { peerDependencies: { '@maronn-openid-connect/core': '>=0.1.0 <1.0.0' } },
        '0.1.0',
      );
    });
  });

  it('should accept a lower bound above the next core version', () => {
    assert.doesNotThrow(() => {
      assertExperimentalCorePeerRangeCoversNextCore(
        { peerDependencies: { '@maronn-openid-connect/core': '>=0.2.0 <1.0.0' } },
        '0.1.0',
      );
    });
  });

  it('should reject a lower bound below the next core version', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerRangeCoversNextCore(
          { peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' } },
          '0.1.0',
        ),
      /">=0\.0\.1 <1\.0\.0" は core 0\.1\.0 より古い 0\.0\.1 を下限にしています/,
    );
  });

  it('should compare each version segment numerically rather than as text', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerRangeCoversNextCore(
          { peerDependencies: { '@maronn-openid-connect/core': '>=0.9.0 <1.0.0' } },
          '0.10.0',
        ),
      /core 0\.10\.0 より古い 0\.9\.0 を下限にしています/,
    );
  });

  it('should reject a range whose lower bound cannot be read', () => {
    assert.throws(
      () =>
        assertExperimentalCorePeerRangeCoversNextCore(
          { peerDependencies: { '@maronn-openid-connect/core': '^0.1.0' } },
          '0.1.0',
        ),
      /"\^0\.1\.0" から下限を読み取れません/,
    );
  });
});

describe('assertPrivatePackagesAreNotVersioned', () => {
  it('should accept a config that turns versioning off for private packages', () => {
    assert.doesNotThrow(() => {
      assertPrivatePackagesAreNotVersioned({ privatePackages: { version: false, tag: false } });
    });
  });

  it('should accept the false shorthand that turns off both versioning and tagging', () => {
    assert.doesNotThrow(() => {
      assertPrivatePackagesAreNotVersioned({ privatePackages: false });
    });
  });

  it('should reject a config without privatePackages because Changesets versions them by default', () => {
    assert.throws(
      () => assertPrivatePackagesAreNotVersioned({ access: 'public' }),
      /`privatePackages\.version` を false にしてください/,
    );
  });

  it('should reject a config that keeps versioning private packages', () => {
    assert.throws(
      () => assertPrivatePackagesAreNotVersioned({ privatePackages: { version: true } }),
      /`privatePackages\.version` を false にしてください/,
    );
  });

  it('should reject a config that only omits the version key', () => {
    assert.throws(
      () => assertPrivatePackagesAreNotVersioned({ privatePackages: { tag: false } }),
      /`privatePackages\.version` を false にしてください/,
    );
  });
});
