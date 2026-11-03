/**
 * CORS for the endpoints browser-based clients call (OAuth 2.1 §4.2): the
 * token endpoint, UserInfo, the protected endpoints of the features, and the
 * metadata documents (discovery, JWKS).
 *
 * Written against the request context the endpoints use (c.req, c.header,
 * c.body), so the same middleware runs on Hono and on the WebRouter of the
 * Express and Fastify output.
 */
import type { CorsOrigins } from './app.js';

export interface CorsOptions {
  /** '*' answers every origin; a string or a list answers only those origins. */
  origins: CorsOrigins;
  allowMethods: readonly string[];
  allowHeaders: readonly string[];
  /** Seconds a browser may cache the preflight answer. */
  maxAge: number;
}

/**
 * `Access-Control-Allow-Origin` に入れる値を返す。
 *
 * `allowed` が一つの文字列（`*` か一つのオリジン）なら、リクエストの `Origin` にかかわらずその文字列を返す。
 * 配列なら、リクエストの `Origin` が含まれるときだけその値を返し、それ以外は `undefined` を返す（ヘッダーを付けない）。
 */
export function resolveCorsOrigin(requestOrigin: string | null, allowed: CorsOrigins): string | undefined {
  if (allowed === '*') return '*';
  if (typeof allowed === 'string') return allowed;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

/**
 * CORS のヘッダーを付けるミドルウェアを作って返す。
 *
 * ミドルウェアは、登録したパスのレスポンスに、`Vary: Origin`、`options` の許可するメソッド、許可するヘッダー、キャッシュしてよい秒数を付ける。
 * `resolveCorsOrigin()` がリクエストの `Origin` を許可すれば、`Access-Control-Allow-Origin` も付ける。
 * プリフライト（`OPTIONS`）には、後続の処理を呼ばずに、ボディなしの 204 で応答する。
 */
export function createCorsMiddleware(options: CorsOptions) {
  return async (c: any, next: () => Promise<unknown>): Promise<Response | void> => {
    const origin = resolveCorsOrigin(c.req.header('Origin') ?? null, options.origins);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
    }
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', options.allowMethods.join(','));
    c.header('Access-Control-Allow-Headers', options.allowHeaders.join(','));
    c.header('Access-Control-Max-Age', String(options.maxAge));

    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  };
}
