/**
 * dynamic-client-registration テスト専用フィクスチャ。
 *
 * tsconfig の exclude 対象なので dist へは出ない（公開 package に載らない）。
 * software statement の発行者を演じるための鍵生成と JWS 組み立てを Web Crypto
 * API だけで行い、edge-runtime 環境のテストでそのまま動くようにしている。
 */
import type { Jwk, JwkSet } from '@maronn-openid-connect/core';

export interface TestSigningKey {
  privateKey: CryptoKey;
  jwk: Jwk;
  jwks: JwkSet;
}

/** RS256 の鍵ペアを生成し、秘密鍵と公開 JWK セットを返す。 */
export async function generateTestRs256Key(keyId: string): Promise<TestSigningKey> {
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
  return exportTestKey(keyPair, keyId, 'RS256');
}

/** ES256 の鍵ペアを生成し、秘密鍵と公開 JWK セットを返す。 */
export async function generateTestEs256Key(keyId: string): Promise<TestSigningKey> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return exportTestKey(keyPair, keyId, 'ES256');
}

async function exportTestKey(keyPair: CryptoKeyPair, keyId: string, alg: string): Promise<TestSigningKey> {
  const exported = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as Record<string, unknown>;
  const jwk = {
    kty: exported['kty'],
    ...(exported['kty'] === 'RSA' ? { n: exported['n'], e: exported['e'] } : { crv: exported['crv'], x: exported['x'], y: exported['y'] }),
    alg,
    use: 'sig',
    kid: keyId,
  } as Jwk;
  return { privateKey: keyPair.privateKey, jwk, jwks: { keys: [jwk] } };
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

/**
 * 任意のヘッダーとペイロードで compact JWS を組み立てる。alg はヘッダーの値から
 * RSASSA-PKCS1-v1_5（RS256）か ECDSA P-256（ES256）を選ぶ。
 */
export async function signTestJwt(options: {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  privateKey: CryptoKey;
}): Promise<string> {
  const encodedHeader = base64UrlFromJson(options.header);
  const encodedPayload = base64UrlFromJson(options.payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const algorithm =
    options.header['alg'] === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const signature = await crypto.subtle.sign(
    algorithm,
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
