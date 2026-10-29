/**
 * Software statements (RFC 7591 §2.3) for the tests of the register endpoint:
 * a publisher key pair and a compact JWS signed with it.
 */
import type { JwkSet, SigningKey } from '@maronn-openid-connect/core';
import { rs256Key } from './keys.js';

/** The issuer the test publisher signs as. */
export const TEST_PUBLISHER = 'https://publisher.example.com';

/** The RS256 key of the test publisher and its public JWK Set. */
export async function publisherKey(keyId = 'test-publisher-key'): Promise<{ signingKey: SigningKey; jwks: JwkSet }> {
  const signingKey = await rs256Key(keyId);
  return { signingKey, jwks: { keys: [signingKey.publicJwk as JwkSet['keys'][number]] } };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function encodeSegment(value: Record<string, unknown>): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** A software statement of TEST_PUBLISHER with the given metadata claims, signed RS256. */
export async function signSoftwareStatement(
  claims: Record<string, unknown>,
  signingKey: SigningKey,
  header: Record<string, unknown> = { alg: 'RS256', kid: signingKey.keyId },
): Promise<string> {
  const signingInput = `${encodeSegment(header)}.${encodeSegment({ iss: TEST_PUBLISHER, ...claims })}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
