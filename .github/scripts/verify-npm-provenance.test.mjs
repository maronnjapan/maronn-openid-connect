import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertPublishedPackageProvenance } from './verify-npm-provenance.mjs';

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
