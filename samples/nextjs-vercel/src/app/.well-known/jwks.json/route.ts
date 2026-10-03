/**
 * JWKS endpoint: the public keys every OP-signed token is verified with.
 *
 * All three key sets are published (general, ID Token, UserInfo) including
 * rotated-out keys, so tokens signed before a rotation keep verifying until
 * they expire. A kid appears once; of the keys without a kid only the most
 * recently added one is published.
 */
import { exportJwks, extractAlgorithmParamsFromJwk, type SigningKey } from '@maronn-openid-connect/core';
import { loadSigningKeys } from '../../_oidc-provider/provider';
import {
  corsPreflight,
  publicCors,
  signingKeysUnavailable,
  withCors,
} from '../../_oidc-provider/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return withCors(request, publicCors, await jwks());
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, publicCors);
}

async function jwks(): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  const published = publishedKeys([
    ...keys.general.registered,
    ...keys.idToken.registered,
    ...keys.userinfo.registered,
  ]);
  const entries = await Promise.all(
    published.map(async (key) => ({
      publicKey: await crypto.subtle.importKey(
        'jwk',
        key.publicJwk,
        extractAlgorithmParamsFromJwk(key.publicJwk),
        true,
        ['verify'],
      ),
      keyId: key.keyId,
    })),
  );

  return Response.json(await exportJwks(entries), {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}

/**
 * The first key of every kid, plus the last key that has no kid (the most
 * recent one wins, since rotation appends).
 */
function publishedKeys(candidates: readonly SigningKey[]): SigningKey[] {
  let lastWithoutKid = -1;
  candidates.forEach((key, index) => {
    if (key.keyId === undefined) lastWithoutKid = index;
  });
  const seenKids = new Set<string>();
  return candidates.filter((key, index) => {
    if (key.keyId === undefined) return index === lastWithoutKid;
    if (seenKids.has(key.keyId)) return false;
    seenKids.add(key.keyId);
    return true;
  });
}
