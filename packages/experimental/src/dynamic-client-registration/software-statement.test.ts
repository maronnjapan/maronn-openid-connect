import { beforeAll, describe, expect, it } from 'vitest';
import { ClientRegistrationError } from './registration-error.js';
import {
  applySoftwareStatement,
  verifySoftwareStatement,
  type SoftwareStatementPublisher,
} from './software-statement.js';
import {
  base64UrlFromJson,
  generateTestEs256Key,
  generateTestRs256Key,
  signTestJwt,
  tamperSignature,
  type TestSigningKey,
} from './test-helpers.js';

/** 承認する発行者の issuer。 */
const PUBLISHER = 'https://publisher.example.com';
/** 2026-01-01T00:00:00Z。 */
const NOW = Date.UTC(2026, 0, 1);
const now = (): number => NOW;

let publisherKey: TestSigningKey;
let otherKey: TestSigningKey;
let ecKey: TestSigningKey;
let publishers: SoftwareStatementPublisher[];

beforeAll(async () => {
  publisherKey = await generateTestRs256Key('publisher-key');
  otherKey = await generateTestRs256Key('other-key');
  ecKey = await generateTestEs256Key('publisher-ec-key');
  publishers = [{ issuer: PUBLISHER, jwks: publisherKey.jwks }];
});

/** 発行者が署名した software statement（RFC 7591 §2.3 の例に沿ったクレーム）。 */
async function statement(
  claims: Record<string, unknown> = {},
  options: { key?: TestSigningKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const key = options.key ?? publisherKey;
  return signTestJwt({
    header: { alg: key.jwk.alg, kid: key.jwk.kid, ...options.header },
    payload: {
      iss: PUBLISHER,
      software_id: '4NRB1-0XZABZI9E6-5SM3R',
      client_name: 'Example Statement-based Client',
      client_uri: 'https://client.example.net/',
      ...claims,
    },
    privateKey: key.privateKey,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<ClientRegistrationError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ClientRegistrationError);
  return error as ClientRegistrationError;
}

describe('verifySoftwareStatement', () => {
  describe('verified statements (RFC 7591 Section 3.1.1)', () => {
    it('should return the issuer and the asserted metadata without the JWT claims', async () => {
      const verified = await verifySoftwareStatement(
        await statement({ iat: 1_767_225_000, exp: 1_767_226_000, nbf: 1_767_225_000, jti: 'id-1', sub: 'x', aud: 'y' }),
        { publishers, now },
      );
      expect(verified).toEqual({
        issuer: PUBLISHER,
        metadata: {
          software_id: '4NRB1-0XZABZI9E6-5SM3R',
          client_name: 'Example Statement-based Client',
          client_uri: 'https://client.example.net/',
        },
      });
    });

    it('should accept a statement without exp and nbf', async () => {
      const verified = await verifySoftwareStatement(await statement(), { publishers, now });
      expect(verified.issuer).toBe(PUBLISHER);
    });

    it('should verify an ES256 statement of a publisher registered with an EC key', async () => {
      const verified = await verifySoftwareStatement(await statement({}, { key: ecKey }), {
        publishers: [{ issuer: PUBLISHER, jwks: ecKey.jwks }],
        now,
      });
      expect(verified.metadata['software_id']).toBe('4NRB1-0XZABZI9E6-5SM3R');
    });

    it('should accept the algorithms a publisher lists', async () => {
      const verified = await verifySoftwareStatement(await statement(), {
        publishers: [{ issuer: PUBLISHER, jwks: publisherKey.jwks, algorithms: ['RS256'] }],
        now,
      });
      expect(verified.issuer).toBe(PUBLISHER);
    });
  });

  describe('invalid_software_statement (RFC 7591 Section 3.2.2)', () => {
    const notCompact = new ClientRegistrationError(
      'invalid_software_statement',
      'software_statement must be a JWS compact serialization',
    );

    it.each([
      ['a plain string', 'not-a-jwt'],
      ['two segments', 'eyJhbGciOiJSUzI1NiJ9.e30'],
      ['a payload that is not base64url JSON', 'eyJhbGciOiJSUzI1NiJ9.%%%.sig'],
      ['a payload that is a JSON array', `eyJhbGciOiJSUzI1NiJ9.${base64UrlFromJson({}).replace(/.*/, 'W10')}.sig`],
    ])('should reject %s', async (_label, value) => {
      const error = await rejectionOf(verifySoftwareStatement(value, { publishers, now }));
      expect(error).toEqual(notCompact);
    });

    it('should reject a statement without an iss claim', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(
          await signTestJwt({
            header: { alg: 'RS256' },
            payload: { software_id: 'x' },
            privateKey: publisherKey.privateKey,
          }),
          { publishers, now },
        ),
      );
      expect(error).toEqual(
        new ClientRegistrationError('invalid_software_statement', 'software_statement must carry an iss claim'),
      );
    });

    const unverifiable = new ClientRegistrationError(
      'invalid_software_statement',
      'the signature of the software_statement could not be verified',
    );

    it('should reject a tampered signature', async () => {
      const error = await rejectionOf(verifySoftwareStatement(tamperSignature(await statement()), { publishers, now }));
      expect(error).toEqual(unverifiable);
    });

    it('should reject a statement signed by a key the publisher did not register', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(await statement({}, { key: otherKey }), { publishers, now }),
      );
      expect(error).toEqual(unverifiable);
    });

    it('should reject an alg outside the algorithms of the publisher without reflecting it', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(await statement({}, { key: ecKey }), {
          publishers: [{ issuer: PUBLISHER, jwks: ecKey.jwks, algorithms: ['RS256'] }],
          now,
        }),
      );
      expect(error).toEqual(unverifiable);
    });

    // RFC 7515 §6 / RFC 8725 §3.1: an unsigned statement proves nothing.
    it('should reject an unsigned statement even when none is listed', async () => {
      const header = base64UrlFromJson({ alg: 'none' });
      const payload = base64UrlFromJson({ iss: PUBLISHER, software_id: 'x' });
      const error = await rejectionOf(
        verifySoftwareStatement(`${header}.${payload}.`, {
          publishers: [{ issuer: PUBLISHER, jwks: publisherKey.jwks, algorithms: ['none', 'RS256'] }],
          now,
        }),
      );
      expect(error).toEqual(unverifiable);
    });

    it('should reject an expired statement', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(await statement({ exp: Math.floor(NOW / 1000) - 1 }), { publishers, now }),
      );
      expect(error).toEqual(
        new ClientRegistrationError('invalid_software_statement', 'the software_statement has expired'),
      );
    });

    it('should reject a statement whose exp is not a number', async () => {
      const error = await rejectionOf(verifySoftwareStatement(await statement({ exp: 'never' }), { publishers, now }));
      expect(error).toEqual(
        new ClientRegistrationError('invalid_software_statement', 'the software_statement has expired'),
      );
    });

    it('should reject a statement that is not yet valid', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(await statement({ nbf: Math.floor(NOW / 1000) + 60 }), { publishers, now }),
      );
      expect(error).toEqual(
        new ClientRegistrationError('invalid_software_statement', 'the software_statement is not yet valid'),
      );
    });
  });

  describe('unapproved_software_statement (RFC 7591 Section 3.2.2)', () => {
    const unapproved = new ClientRegistrationError(
      'unapproved_software_statement',
      'the issuer of the software_statement is not approved by this authorization server',
    );

    it('should reject a statement of an issuer that is not a publisher', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(await statement({ iss: 'https://unknown.example.com' }), { publishers, now }),
      );
      expect(error).toEqual(unapproved);
    });

    it('should reject every statement when no publisher is approved', async () => {
      const error = await rejectionOf(verifySoftwareStatement(await statement(), { publishers: [], now }));
      expect(error).toEqual(unapproved);
    });

    it('should decide on the issuer before the signature, so an unapproved issuer never gets a signature verdict', async () => {
      const error = await rejectionOf(
        verifySoftwareStatement(tamperSignature(await statement({ iss: 'https://unknown.example.com' })), {
          publishers,
          now,
        }),
      );
      expect(error).toEqual(unapproved);
    });
  });
});

describe('applySoftwareStatement', () => {
  it('should let the asserted metadata take precedence over the plain metadata and keep the statement', () => {
    const merged = applySoftwareStatement(
      { redirect_uris: ['https://app.example.com/cb'], client_name: 'Plain Name', scope: 'openid' },
      'eyJhbGciOiJSUzI1NiJ9.e30.sig',
      { issuer: PUBLISHER, metadata: { client_name: 'Asserted Name', software_id: 'sw-1' } },
    );
    expect(merged).toEqual({
      redirect_uris: ['https://app.example.com/cb'],
      client_name: 'Asserted Name',
      scope: 'openid',
      software_id: 'sw-1',
      software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig',
    });
  });

  it('should build a new object with the Object prototype', () => {
    const plain = JSON.parse('{"redirect_uris":["https://app.example.com/cb"],"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const merged = applySoftwareStatement(plain, 'eyJhbGciOiJSUzI1NiJ9.e30.sig', { issuer: PUBLISHER, metadata: {} });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    // The key stays an inert own data property that validateClientMetadata ignores as unknown metadata.
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
  });
});
