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

/**
 * JWK Set に CORS のヘッダーを付けて応答する。
 *
 * GET `/.well-known/jwks.json` に、`jwks()` のレスポンスに `publicCors` のヘッダーを付けて応答する。
 * `publicCors` のヘッダーを付けるので、どのオリジンからも読める。
 */
export async function GET(request: Request): Promise<Response> {
  return withCors(request, publicCors, await jwks());
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/.well-known/jwks.json` で、応答には、どのオリジンからも GET できるようにする `publicCors` のヘッダーを付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, publicCors);
}

/**
 * すべての署名鍵の公開鍵の JWK Set で応答する。
 *
 * 汎用、ID トークン用、UserInfo 用の鍵の集合をこの順につなぎ、同じ `kid` の鍵は 1 つだけ含める（`publishedKeys()`）。
 * 各鍵の公開 JWK を検証用の鍵として読み込み直し、`use`、`alg`、`kid` を付けた JWK にする（core の `exportJwks()`）。
 * レスポンスは 1 時間キャッシュしてよい（`Cache-Control: public, max-age=3600`）。
 * 署名鍵を読み込めないときは、503 の `server_error` で応答する。
 *
 * 鍵を入れ替えた後も集合に残した鍵は公開し続けるので、その鍵で署名したトークンも検証できる。
 * `kid` のない鍵は、最も新しいものだけを公開する。
 */
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
 * `kid` ごとに最初の鍵だけを残した配列を返す。
 *
 * `kid` のない鍵は 1 つの `kid` として扱うので、そのうち最初の鍵だけを残す。
 * 鍵の集合は新しい鍵から並ぶので、残るのは最も新しい鍵である。
 */
function publishedKeys(candidates: readonly SigningKey[]): SigningKey[] {
  const seenKids = new Set<string>();
  return candidates.filter((key) => {
    if (seenKids.has(key.keyId)) return false;
    seenKids.add(key.keyId);
    return true;
  });
}
