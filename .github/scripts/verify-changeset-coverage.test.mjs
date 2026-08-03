import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertChangesetCoversChangedPackages,
  findChangedPublishablePackages,
  isReleaseRelevantPath,
  selectPublishablePackages,
} from './verify-changeset-coverage.mjs';

const PACKAGES = [
  { name: '@maronn-oidc/cli', directory: 'packages/cli' },
  { name: '@maronn-oidc/core', directory: 'packages/core' },
];

describe('selectPublishablePackages', () => {
  it('should keep packages that are not private', () => {
    assert.deepEqual(
      selectPublishablePackages([
        { directory: 'packages/cli', manifest: { name: '@maronn-oidc/cli' } },
        { directory: 'packages/core', manifest: { name: '@maronn-oidc/core' } },
      ]),
      PACKAGES,
    );
  });

  it('should drop packages marked private', () => {
    assert.deepEqual(
      selectPublishablePackages([
        { directory: 'packages/cli', manifest: { name: '@maronn-oidc/cli' } },
        { directory: 'docs/library-document', manifest: { name: '@maronn-oidc/docs', private: true } },
      ]),
      [{ name: '@maronn-oidc/cli', directory: 'packages/cli' }],
    );
  });

  it('should drop packages without a name', () => {
    assert.deepEqual(selectPublishablePackages([{ directory: 'packages/cli', manifest: {} }]), []);
  });
});

describe('isReleaseRelevantPath', () => {
  // 出荷物に入る変更は publish が必要なので、changeset を要求する
  it('should treat a source file as release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/src/features.ts'), true);
  });

  it('should treat package.json as release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/package.json'), true);
  });

  // README は package.json の files に含まれるため npm に出荷される
  it('should treat README.md as release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/README.md'), true);
  });

  // 出荷物に入らない変更は publish を伴わないので、changeset を要求しない
  it('should treat a file under __tests__ as not release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/src/__tests__/features.test.ts'), false);
  });

  it('should treat a colocated test file as not release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/src/features.test.ts'), false);
  });

  it('should treat CHANGELOG.md as not release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/CHANGELOG.md'), false);
  });

  it('should treat vitest.config.ts as not release relevant', () => {
    assert.equal(isReleaseRelevantPath('packages/cli/vitest.config.ts'), false);
  });
});

describe('findChangedPublishablePackages', () => {
  it('should return the package that owns the changed file', () => {
    assert.deepEqual(
      findChangedPublishablePackages(['packages/cli/src/features.ts'], PACKAGES),
      ['@maronn-oidc/cli'],
    );
  });

  it('should return every changed package sorted by name', () => {
    assert.deepEqual(
      findChangedPublishablePackages(
        ['packages/core/src/index.ts', 'packages/cli/src/features.ts'],
        PACKAGES,
      ),
      ['@maronn-oidc/cli', '@maronn-oidc/core'],
    );
  });

  it('should report a package only once when several of its files change', () => {
    assert.deepEqual(
      findChangedPublishablePackages(
        ['packages/cli/src/features.ts', 'packages/cli/src/index.ts'],
        PACKAGES,
      ),
      ['@maronn-oidc/cli'],
    );
  });

  it('should ignore files outside any publishable package', () => {
    assert.deepEqual(
      findChangedPublishablePackages(['samples/hono-cloudflare/src/index.ts', 'RELEASE.md'], PACKAGES),
      [],
    );
  });

  it('should ignore test-only changes inside a publishable package', () => {
    assert.deepEqual(
      findChangedPublishablePackages(['packages/cli/src/__tests__/cli.test.ts'], PACKAGES),
      [],
    );
  });

  // 'packages/cli-extra' が 'packages/cli' の変更として誤判定されないこと
  it('should not match a package whose directory is a name prefix of another', () => {
    assert.deepEqual(
      findChangedPublishablePackages(['packages/cli-extra/src/index.ts'], PACKAGES),
      [],
    );
  });
});

describe('assertChangesetCoversChangedPackages', () => {
  it('should accept a pull request that changes no publishable package', () => {
    assert.doesNotThrow(() => {
      assertChangesetCoversChangedPackages({ changedPackages: [], addedChangesets: [] });
    });
  });

  it('should accept a changed package covered by an added changeset', () => {
    assert.doesNotThrow(() => {
      assertChangesetCoversChangedPackages({
        changedPackages: ['@maronn-oidc/cli'],
        addedChangesets: [{ file: 'brave-pugs-smile.md', bumps: { '@maronn-oidc/cli': 'minor' } }],
      });
    });
  });

  it('should accept every changed package covered across several added changesets', () => {
    assert.doesNotThrow(() => {
      assertChangesetCoversChangedPackages({
        changedPackages: ['@maronn-oidc/cli', '@maronn-oidc/core'],
        addedChangesets: [
          { file: 'a.md', bumps: { '@maronn-oidc/cli': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-oidc/core': 'patch' } },
        ],
      });
    });
  });

  // `pnpm changeset --empty` を明示的なリリース不要の意思表示として扱う
  it('should accept an empty changeset as an explicit opt-out', () => {
    assert.doesNotThrow(() => {
      assertChangesetCoversChangedPackages({
        changedPackages: ['@maronn-oidc/cli'],
        addedChangesets: [{ file: 'empty.md', bumps: {} }],
      });
    });
  });

  it('should reject a changed package with no added changeset', () => {
    assert.throws(
      () => {
        assertChangesetCoversChangedPackages({
          changedPackages: ['@maronn-oidc/cli'],
          addedChangesets: [],
        });
      },
      { message: /@maronn-oidc\/cli/ },
    );
  });

  it('should reject when only some of the changed packages are covered', () => {
    assert.throws(
      () => {
        assertChangesetCoversChangedPackages({
          changedPackages: ['@maronn-oidc/cli', '@maronn-oidc/core'],
          addedChangesets: [{ file: 'a.md', bumps: { '@maronn-oidc/cli': 'minor' } }],
        });
      },
      { message: /@maronn-oidc\/core/ },
    );
  });

  // main に溜まっている既存 changeset では、この PR の変更は CHANGELOG に載らない
  it('should reject a changeset that covers a different package than the changed one', () => {
    assert.throws(
      () => {
        assertChangesetCoversChangedPackages({
          changedPackages: ['@maronn-oidc/cli'],
          addedChangesets: [{ file: 'a.md', bumps: { '@maronn-oidc/core': 'patch' } }],
        });
      },
      { message: /@maronn-oidc\/cli/ },
    );
  });

  it('should tell the author how to add the missing changeset', () => {
    assert.throws(
      () => {
        assertChangesetCoversChangedPackages({
          changedPackages: ['@maronn-oidc/cli'],
          addedChangesets: [],
        });
      },
      { message: /pnpm changeset/ },
    );
  });
});
