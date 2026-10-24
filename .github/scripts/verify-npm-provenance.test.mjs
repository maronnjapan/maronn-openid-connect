import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertPublishedPackageProvenance,
  selectUnlistedPackages,
  waitForRegistryToListPublishedPackages,
} from './verify-npm-provenance.mjs';

const publishedPackages = [
  { name: '@maronn-openid-connect/core', version: '1.2.3' },
  { name: '@maronn-openid-connect/cli', version: '1.2.3' },
];

const provenanceFor = (name, version) => ({
  name,
  version,
  attestations: {
    provenance: {
      predicateType: 'https://slsa.dev/provenance/v1',
    },
  },
});

describe('assertPublishedPackageProvenance', () => {
  it('should accept verified SLSA provenance for every published package version', () => {
    const auditResult = {
      invalid: [],
      missing: [],
      verified: publishedPackages.map(({ name, version }) => provenanceFor(name, version)),
    };

    assert.doesNotThrow(() => {
      assertPublishedPackageProvenance(publishedPackages, auditResult);
    });
  });

  it('should reject a package that only has a registry signature', () => {
    const auditResult = {
      invalid: [],
      missing: [],
      verified: [],
    };

    assert.throws(
      () => assertPublishedPackageProvenance(publishedPackages, auditResult),
      new Error(
        'Missing verified SLSA provenance attestation for: ' +
          '@maronn-openid-connect/core@1.2.3, @maronn-openid-connect/cli@1.2.3',
      ),
    );
  });

  it('should reject provenance attached to a different package version', () => {
    const auditResult = {
      invalid: [],
      missing: [],
      verified: [
        provenanceFor('@maronn-openid-connect/core', '1.2.2'),
        provenanceFor('@maronn-openid-connect/cli', '1.2.3'),
      ],
    };

    assert.throws(
      () => assertPublishedPackageProvenance(publishedPackages, auditResult),
      new Error(
        'Missing verified SLSA provenance attestation for: ' +
          '@maronn-openid-connect/core@1.2.3',
      ),
    );
  });

  it('should reject a non-SLSA attestation for a published package', () => {
    const auditResult = {
      invalid: [],
      missing: [],
      verified: [
        {
          name: '@maronn-openid-connect/core',
          version: '1.2.3',
          attestations: {
            provenance: {
              predicateType: 'https://example.com/custom-provenance/v1',
            },
          },
        },
        provenanceFor('@maronn-openid-connect/cli', '1.2.3'),
      ],
    };

    assert.throws(
      () => assertPublishedPackageProvenance(publishedPackages, auditResult),
      new Error(
        'Missing verified SLSA provenance attestation for: ' +
          '@maronn-openid-connect/core@1.2.3',
      ),
    );
  });
});

describe('selectUnlistedPackages', () => {
  it('should select the published versions that the registry does not list yet', () => {
    assert.deepEqual(
      selectUnlistedPackages(publishedPackages, {
        '@maronn-openid-connect/core': ['1.2.2', '1.2.3'],
        '@maronn-openid-connect/cli': ['1.2.2'],
      }),
      [{ name: '@maronn-openid-connect/cli', version: '1.2.3' }],
    );
  });

  it('should select a package that the registry lookup did not return', () => {
    assert.deepEqual(selectUnlistedPackages(publishedPackages, { '@maronn-openid-connect/core': ['1.2.3'] }), [
      { name: '@maronn-openid-connect/cli', version: '1.2.3' },
    ]);
  });
});

/** 経過時間を sleep の合計で進める時計。実際には待たない。 */
const fakeClock = () => {
  let elapsed = 0;
  const sleeps = [];
  return {
    now: () => elapsed,
    sleep: async (ms) => {
      sleeps.push(ms);
      elapsed += ms;
    },
    sleeps,
  };
};

describe('waitForRegistryToListPublishedPackages', () => {
  it('should return without waiting when the registry already lists every published version', async () => {
    const clock = fakeClock();

    await waitForRegistryToListPublishedPackages(publishedPackages, {
      fetchListedVersions: async () => ['1.2.3'],
      ...clock,
    });

    assert.deepEqual(clock.sleeps, []);
  });

  // npm は publish を受け付けてから packument に載せるまで数分かかる（run 121 で 5 分、run 118 で 7 分）。
  it('should keep polling until the registry lists the versions this run published', async () => {
    const clock = fakeClock();
    const listedAfter = { '@maronn-openid-connect/core': 60_000, '@maronn-openid-connect/cli': 300_000 };

    await waitForRegistryToListPublishedPackages(publishedPackages, {
      fetchListedVersions: async (name) => (clock.now() >= listedAfter[name] ? ['1.2.2', '1.2.3'] : ['1.2.2']),
      intervalMs: 30_000,
      ...clock,
    });

    assert.equal(clock.now(), 300_000);
  });

  it('should keep polling after a failed registry lookup', async () => {
    const clock = fakeClock();
    let calls = 0;

    await waitForRegistryToListPublishedPackages(publishedPackages, {
      fetchListedVersions: async () => {
        calls += 1;
        if (calls === 1) throw new Error('@maronn-openid-connect/core (503)');
        return ['1.2.3'];
      },
      intervalMs: 30_000,
      ...clock,
    });

    assert.deepEqual(clock.sleeps, [30_000]);
  });

  // 待ちきれなかったら、publish をやり直さずに verify-provenance ジョブだけを re-run できると伝える。
  it('should throw naming the unlisted versions once the timeout runs out', async () => {
    const clock = fakeClock();

    await assert.rejects(
      waitForRegistryToListPublishedPackages(publishedPackages, {
        fetchListedVersions: async (name) => (name === '@maronn-openid-connect/core' ? ['1.2.3'] : ['1.2.2']),
        timeoutMs: 15 * 60 * 1000,
        intervalMs: 30_000,
        ...clock,
      }),
      /npm registry が 15 分待っても次のバージョンを返しません: @maronn-openid-connect\/cli@1\.2\.3\n.*verify-provenance ジョブだけを re-run/s,
    );
    assert.equal(clock.now(), 15 * 60 * 1000);
  });
});
