import { describe, expect, it } from 'vitest';
import { rs256Key } from '../../../../test-support/keys.js';
import { es256Key } from '../../../../test-support/screens.js';
import { buildJwksDocument } from './export-jwks.js';

describe('buildJwksDocument', () => {
  // RFC 7517 §5: the public halves only.
  it('should export the public half of an RSA key with its kid, alg and use', async () => {
    const key = await rs256Key('rsa-1');

    expect(await buildJwksDocument([key])).toEqual({
      keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'rsa-1', n: key.publicJwk.n, e: key.publicJwk.e }],
    });
  });

  it('should export the public half of an EC key with its curve and coordinates', async () => {
    const key = await es256Key('ec-1');

    expect(await buildJwksDocument([key])).toEqual({
      keys: [
        { kty: 'EC', use: 'sig', alg: 'ES256', kid: 'ec-1', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y },
      ],
    });
  });

  // The ID Token and UserInfo key sets default to the general-purpose keys.
  it('should publish a kid that appears in several key sets once, in first-seen order', async () => {
    const first = await rs256Key('rsa-1');
    const second = await es256Key('ec-1');

    const jwks = await buildJwksDocument([first, second, first, second]);

    expect(jwks.keys.map((jwk) => jwk.kid)).toEqual(['rsa-1', 'ec-1']);
  });

  it('should reject an empty key set as a server configuration error', async () => {
    await expect(buildJwksDocument([])).rejects.toThrow('No signing key is registered');
  });
});
