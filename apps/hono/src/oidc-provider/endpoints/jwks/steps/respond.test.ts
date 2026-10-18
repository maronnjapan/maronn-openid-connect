import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { respondJwks } from './respond.js';

const jwks = { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'rsa-1', n: 'n-value', e: 'AQAB' }] };

describe('respondJwks', () => {
  it('should answer 200 with the JWK Set as JSON', async () => {
    const response = respondJwks(contextOf(), jwks);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual(jwks);
  });

  it('should mark the JWK Set cacheable for 3600 seconds', () => {
    expect(respondJwks(contextOf(), jwks).headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
});
