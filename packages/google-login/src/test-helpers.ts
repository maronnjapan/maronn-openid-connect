/**
 * テスト専用フィクスチャ（tsconfig の exclude で dist には出ない）。
 *
 * Google の代わりに RSA 鍵で ID トークンを署名し、google-auth-library が公開鍵を取りに行く
 * エンドポイントをローカルの HTTP サーバーで偽装する。
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { OAuth2ClientOptions } from 'google-auth-library';
import { expect } from 'vitest';

import { GoogleLoginError, type GoogleLoginErrorCode } from './errors.js';
import type { GoogleIdTokenPayload, GoogleIdTokenVerifier } from './id-token.js';
import type { GoogleLoginNonceRecord, GoogleLoginNonceStore } from './nonce.js';

export const TEST_CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';

export interface GoogleTestKey {
  kid: string;
  privateKey: KeyObject;
  /** SPKI / PEM。google-auth-library は Node.js では PEM 形式のエンドポイントを使う。 */
  publicKeyPem: string;
  jwk: Record<string, unknown>;
}

export function generateGoogleTestKey(kid = 'test-kid-1'): GoogleTestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

export function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Google のドキュメントに載っている形のペイロード（値は架空）。 */
export function createGoogleIdTokenPayload(overrides: Record<string, unknown> = {}): GoogleIdTokenPayload {
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
  } as GoogleIdTokenPayload;
}

export function signGoogleIdToken(options: {
  key: GoogleTestKey;
  payload: GoogleIdTokenPayload | Record<string, unknown>;
  header?: Record<string, unknown>;
}): string {
  const header = { alg: 'RS256', kid: options.key.kid, typ: 'JWT', ...options.header };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(options.payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(options.key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export interface CertsServer {
  baseUrl: string;
  /** 受け取ったリクエストのパス。 */
  hits: string[];
  /** このサーバーを公開鍵の取得先にする `OAuth2Client` のオプション。 */
  clientOptions: OAuth2ClientOptions;
  close(): Promise<void>;
}

/**
 * Google の公開鍵エンドポイントを偽装するローカル HTTP サーバーを起動する。
 *
 * - `/oauth2/v1/certs`: `{ kid: PEM }`（google-auth-library が Node.js で使う形式）
 * - `/oauth2/v3/certs`: JWK Set
 * - `status` を指定すると全リクエストにそのステータスを返す
 */
export async function startCertsServer(
  keys: readonly GoogleTestKey[],
  options: { maxAge?: number; status?: number } = {},
): Promise<CertsServer> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    if (options.status !== undefined) {
      response.statusCode = options.status;
      response.end();
      return;
    }
    const headers = {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${options.maxAge ?? 3600}, must-revalidate, no-transform`,
    };
    if (request.url === '/oauth2/v1/certs') {
      response.writeHead(200, headers);
      response.end(JSON.stringify(Object.fromEntries(keys.map((key) => [key.kid, key.publicKeyPem]))));
      return;
    }
    if (request.url === '/oauth2/v3/certs') {
      response.writeHead(200, headers);
      response.end(JSON.stringify({ keys: keys.map((key) => key.jwk) }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    hits,
    clientOptions: {
      endpoints: {
        oauth2FederatedSignonPemCertsUrl: `${baseUrl}/oauth2/v1/certs`,
        oauth2FederatedSignonJwkCertsUrl: `${baseUrl}/oauth2/v3/certs`,
      },
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface FakeVerifier extends GoogleIdTokenVerifier {
  calls: Array<{ idToken: string; clientId: string | readonly string[] }>;
}

/** 検証本体を差し替えた verifier。合成関数のテストで google-auth-library に触れないために使う。 */
export function createFakeVerifier(
  handler: (idToken: string, clientId: string | readonly string[]) => GoogleIdTokenPayload | Promise<GoogleIdTokenPayload>,
): FakeVerifier {
  const calls: FakeVerifier['calls'] = [];
  return {
    calls,
    async verify(idToken, clientId) {
      calls.push({ idToken, clientId });
      return handler(idToken, clientId);
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
