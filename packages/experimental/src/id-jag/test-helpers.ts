/**
 * id-jag テスト専用フィクスチャ。
 *
 * tsconfig の exclude 対象なので dist へは出ない（公開 package に載らない）。
 * 鍵生成と JWS 組み立てを Web Crypto API だけで行い、edge-runtime 環境の
 * テストでそのまま動くようにしている。
 */
import type { webcrypto } from 'node:crypto';
import type { Jwk, JwkSet, SigningKey } from '@maronn-openid-connect/core';

export interface TestRs256Key {
  signingKey: SigningKey;
  jwk: Jwk;
  jwks: JwkSet;
}

/** RS256 鍵ペアを生成し、SigningKey と公開 JWK セットの両形式で返す。 */
export async function generateTestRs256Key(keyId: string): Promise<TestRs256Key> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as Jwk;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = keyId;
  return {
    signingKey: {
      privateKey: keyPair.privateKey,
      publicJwk: publicJwk as unknown as webcrypto.JsonWebKey,
      keyId,
    },
    jwk: publicJwk,
    jwks: { keys: [publicJwk] },
  };
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlFromJson(value: Record<string, unknown>): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJwtSegment(segment: string): Record<string, unknown> {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [headerB64 = '', payloadB64 = ''] = token.split('.');
  return {
    header: decodeJwtSegment(headerB64),
    payload: decodeJwtSegment(payloadB64),
  };
}

/**
 * 任意のヘッダーとペイロードで compact JWS を組み立てる。
 *
 * typ 改変や不正クレームのケースを作るためのテスト専用実装で、
 * 本体実装（createIdJagJwt）とは独立している。
 */
export async function signTestJwt(options: {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  privateKey: CryptoKey;
}): Promise<string> {
  const encodedHeader = base64UrlFromJson(options.header);
  const encodedPayload = base64UrlFromJson(options.payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    options.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/** 署名部だけを別の値に差し替える（署名改ざんケース用）。 */
export function tamperSignature(token: string): string {
  const [headerB64 = '', payloadB64 = ''] = token.split('.');
  return `${headerB64}.${payloadB64}.AAAA`;
}
