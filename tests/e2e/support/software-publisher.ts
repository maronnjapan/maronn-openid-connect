/**
 * EXPERIMENTAL (RFC 7591 §2.3): the software statement publisher of the E2E
 * suite.
 *
 * The restricted-registration OP instance (playwright.config.ts) trusts this
 * publisher through OIDC_DCR_TRUSTED_SOFTWARE_PUBLISHERS_JSON, and the
 * dynamic-client-registration spec signs statements as it. Both sides derive
 * the ES256 key pair from one fixed P-256 private scalar, so the key is the
 * same in the OP process and in every test worker without passing secrets
 * around: a test constant like the client secrets of the E2E clients, never a
 * key of any real deployment.
 */
import { createECDH, createPrivateKey, sign } from 'node:crypto';

export const SOFTWARE_PUBLISHER_ISSUER = 'https://software-publisher.e2e.example.com';
const SOFTWARE_PUBLISHER_KEY_ID = 'e2e-software-publisher-es256';
/** The private scalar of the publisher key (32 bytes, below the P-256 group order). */
const PRIVATE_SCALAR_HEX = '0b0e8e4c6d8f0a7b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d';

function base64Url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function keyPair(): { publicJwk: Record<string, string>; privateJwk: Record<string, string> } {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(PRIVATE_SCALAR_HEX, 'hex'));
  // The uncompressed point: 0x04 || X (32 bytes) || Y (32 bytes).
  const point = ecdh.getPublicKey();
  const publicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64Url(point.subarray(1, 33)),
    y: base64Url(point.subarray(33, 65)),
    alg: 'ES256',
    use: 'sig',
    kid: SOFTWARE_PUBLISHER_KEY_ID,
  };
  return { publicJwk, privateJwk: { ...publicJwk, d: base64Url(Buffer.from(PRIVATE_SCALAR_HEX, 'hex')) } };
}

/** The public JWK Set the OP is given for the publisher. */
export function softwarePublisherJwks(): { keys: Record<string, string>[] } {
  return { keys: [keyPair().publicJwk] };
}

/** OIDC_DCR_TRUSTED_SOFTWARE_PUBLISHERS_JSON for an OP that trusts the publisher. */
export function trustedSoftwarePublishersJson(): string {
  return JSON.stringify([{ issuer: SOFTWARE_PUBLISHER_ISSUER, jwks: softwarePublisherJwks() }]);
}

/** A software statement of the publisher with the given metadata claims, as a compact JWS (ES256). */
export function signSoftwareStatement(claims: Record<string, unknown>): string {
  const header = base64Url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: SOFTWARE_PUBLISHER_KEY_ID, typ: 'JWT' })));
  const payload = base64Url(Buffer.from(JSON.stringify({ iss: SOFTWARE_PUBLISHER_ISSUER, ...claims })));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: keyPair().privateJwk, format: 'jwk' });
  // JWS ES256 carries R || S (RFC 7518 §3.4), not the DER encoding.
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64Url(signature)}`;
}
