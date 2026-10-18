/**
 * Compact JWS for the tests of the features that sign or verify JWTs (JARM,
 * the JWT introspection response, Request Objects), built and read with the
 * Web Crypto API independently of the code under test.
 */
import type { SigningKey } from '@maronn-openid-connect/core';

/** The decoded JOSE header and payload of a compact JWS. */
export function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header = '', payload = ''] = jwt.split('.');
  return { header: decodeJsonSegment(header), payload: decodeJsonSegment(payload) };
}

/** Whether the RS256 signature of a compact JWS verifies with the public key. */
export async function verifyRs256Jwt(jwt: string, publicJwk: JsonWebKey): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const key = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

/** A compact JWS of the payload, signed with RS256 and the key's kid. */
export async function signRs256Jwt(payload: Record<string, unknown>, signingKey: SigningKey): Promise<string> {
  const signingInput = `${base64UrlJson({ alg: 'RS256', kid: signingKey.keyId })}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** An unsigned JWT (alg none, empty signature: RFC 7515 §6 / RFC 7519 §6). */
export function unsignedJwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: 'none' })}.${base64UrlJson(payload)}.`;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
}

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
