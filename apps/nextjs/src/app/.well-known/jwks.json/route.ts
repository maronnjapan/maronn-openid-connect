/**
 * JWKS endpoint: the public keys every OP-signed token is verified with.
 *
 * All three key sets are published (general, ID Token, UserInfo) including
 * rotated-out keys, so tokens signed before a rotation keep verifying until
 * they expire. A kid appears once; of the keys without a kid only the newest
 * one (the first, since a set lists its newest key first) is published.
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
    ...keys.general,
    ...keys.idToken,
    ...keys.userinfo,
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
 * The first key of every kid; keys without a kid count as one kid, so only the
 * first of them (the newest, since a set lists its newest key first) is kept.
 */
function publishedKeys(candidates: readonly SigningKey[]): SigningKey[] {
  const seenKids = new Set<string>();
  return candidates.filter((key) => {
    if (seenKids.has(key.keyId)) return false;
    seenKids.add(key.keyId);
    return true;
  });
}
