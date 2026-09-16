/**
 * テスト専用フィクスチャ（tsconfig の exclude で dist には出ない）。
 *
 * Google の代わりに RSA 鍵で ID トークンを署名し、JWK Set のレスポンスを偽装する。
 */
import { expect } from 'vitest';

import type { GoogleJwk } from './certs.js';
import { GoogleLoginError, type GoogleLoginErrorCode } from './errors.js';
import type { GoogleLoginNonceRecord, GoogleLoginNonceStore } from './nonce.js';

export const TEST_CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';

export interface GoogleTestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: GoogleJwk;
}

export async function generateGoogleTestKey(kid = 'test-kid-1'): Promise<GoogleTestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: exported.n!, e: exported.e! },
  };
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Google のドキュメントに載っている形のペイロード（値は架空）。 */
export function createGoogleIdTokenPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: 'https://accounts.google.com',
    azp: TEST_CLIENT_ID,
    aud: TEST_CLIENT_ID,
    sub: '10769150350006150715113082367',
    email: 'jsmith@example.com',
    email_verified: true,
    name: 'John Smith',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    given_name: 'John',
    family_name: 'Smith',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

export async function signGoogleIdToken(options: {
  key: GoogleTestKey;
  payload: Record<string, unknown>;
  header?: Record<string, unknown>;
}): Promise<string> {
  const header = { alg: 'RS256', kid: options.key.kid, typ: 'JWT', ...options.header };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(options.payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    options.key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export function createJwksResponse(
  keys: readonly GoogleJwk[],
  init: { maxAge?: number; status?: number; cacheControl?: string | null; body?: string } = {},
): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const cacheControl =
    init.cacheControl === undefined
      ? `public, max-age=${init.maxAge ?? 3600}, must-revalidate, no-transform`
      : init.cacheControl;
  if (cacheControl !== null) {
    headers['cache-control'] = cacheControl;
  }
  return new Response(init.body ?? JSON.stringify({ keys }), { status: init.status ?? 200, headers });
}

export interface FakeFetch {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ input: string; init: RequestInit | undefined }>;
}

export function createFakeFetch(
  responder: (call: number) => Response | Promise<Response>,
): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init });
      return responder(calls.length);
    },
  };
}

export interface InMemoryNonceStore extends GoogleLoginNonceStore {
  records: Map<string, GoogleLoginNonceRecord>;
  ttls: Map<string, number>;
}

export function createInMemoryNonceStore(): InMemoryNonceStore {
  const records = new Map<string, GoogleLoginNonceRecord>();
  const ttls = new Map<string, number>();
  return {
    records,
    ttls,
    async get(key) {
      return records.get(key) ?? null;
    },
    async put(key, record, ttlSeconds) {
      records.set(key, record);
      ttls.set(key, ttlSeconds);
    },
    async delete(key) {
      records.delete(key);
      ttls.delete(key);
    },
  };
}

export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

export function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

export function expectGoogleLoginError(
  error: unknown,
  code: GoogleLoginErrorCode,
  httpStatusCode: number,
): void {
  expect(error).toBeInstanceOf(GoogleLoginError);
  const loginError = error as GoogleLoginError;
  expect(loginError.name).toBe('GoogleLoginError');
  expect(loginError.code).toBe(code);
  expect(loginError.httpStatusCode).toBe(httpStatusCode);
}
