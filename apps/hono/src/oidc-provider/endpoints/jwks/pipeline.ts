import { Hono } from 'hono';
import { collectPublishedKeys } from './steps/collect-public-keys.js';
import { buildJwksDocument } from './steps/export-jwks.js';
import { respondJwks } from './steps/respond.js';

/**
 * JWKS endpoint (API layer).
 * Serves the public keys used to verify token signatures.
 *
 * Each block below calls one step of the endpoint (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint jwks`.
 */
export const jwksApp = new Hono<{ Variables: Record<string, any> }>();

jwksApp.get('/', async (c) => {
  try {
    // [collect-public-keys] 登録済みの署名鍵をすべて集める
    const keys = collectPublishedKeys(c);

    // [export-jwks] 公開鍵を JWK Set にまとめる — RFC 7517 §5
    const jwks = await buildJwksDocument(keys);

    // [respond] キャッシュ可能な JWK Set で応答する
    return respondJwks(c, jwks);
  } catch {
    // An empty key set (or a key that cannot be exported) is a configuration
    // problem of the OP, never the caller's.
    return c.json({ error: 'server_error' }, 500);
  }
});
