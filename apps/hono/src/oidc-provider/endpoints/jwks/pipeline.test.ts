import { describe, expect, it } from 'vitest';
import { requestTo } from '../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../test-support/keys.js';
import { es256Key, providerApp } from '../../../test-support/screens.js';
import { createEmptyDatabase } from '../../db/memory/database.js';

const JWKS_PATH = '/.well-known/jwks.json';

describe('jwksApp', () => {
  // RFC 9111 §5.2: the JWK Set is cacheable, like the discovery document.
  it('should answer 200 with the JWK Set as JSON cacheable for 3600 seconds', async () => {
    const app = await providerApp(createEmptyDatabase());

    const response = await app.request(requestTo(JWKS_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  // RFC 7517 §5: a JWK Set of the public halves only, each with its kid (§4.5).
  it('should publish the public half of the signing key', async () => {
    const key = await rs256Key();
    const app = await providerApp(createEmptyDatabase());

    const response = await app.request(requestTo(JWKS_PATH));

    expect(await response.json()).toEqual({
      keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'test-rs256-key', n: key.publicJwk.n, e: 'AQAB' }],
    });
  });

  // T-022: every registered key stays verifiable; a key shared by several sets is published once.
  it('should publish each key of the signing, ID Token and UserInfo key sets once, in that order', async () => {
    const signing = await rs256Key('jwks-signing');
    const idToken = await rs256Key('jwks-id-token');
    const ec = await es256Key('jwks-ec');
    const app = await providerApp(createEmptyDatabase(), {
      signingKeyProvider: staticKeyProvider(signing),
      idTokenSigningKeyProvider: staticKeyProvider(idToken, ec),
      userinfoSigningKeyProvider: staticKeyProvider(ec, signing),
    });

    const response = await app.request(requestTo(JWKS_PATH));

    expect(await response.json()).toEqual({
      keys: [
        { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'jwks-signing', n: signing.publicJwk.n, e: 'AQAB' },
        { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'jwks-id-token', n: idToken.publicJwk.n, e: 'AQAB' },
        { kty: 'EC', use: 'sig', alg: 'ES256', kid: 'jwks-ec', crv: 'P-256', x: ec.publicJwk.x, y: ec.publicJwk.y },
      ],
    });
  });

  it('should answer 500 server_error when a registered public key cannot be exported', async () => {
    const key = await rs256Key();
    // WebCrypto refuses to import a JWK for verify whose key_ops do not allow it.
    const unexportable = { ...key, publicJwk: { ...key.publicJwk, key_ops: ['sign'] } };
    const app = await providerApp(createEmptyDatabase(), { signingKeyProvider: staticKeyProvider(unexportable) });

    const response = await app.request(requestTo(JWKS_PATH));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_error' });
  });
});
