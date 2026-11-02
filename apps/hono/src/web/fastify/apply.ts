/**
 * Apply the OpenID Connect Provider to a Fastify instance.
 *
 * Every path the provider serves (providerRoutes() of app.ts: the endpoints
 * of every provider and those of the generated features, with the paths below
 * them) is registered for every method and handed to the provider's router,
 * which answers CORS preflights and 405 itself. Fastify matches paths exactly,
 * so the paths below a mount point (/device/login, ...) are registered one by
 * one.
 *
 * The routes live in a plugin of their own whose only body parser hands the
 * raw bytes on, since the provider reads form and JSON bodies itself. The body
 * parsers of the instance stay as they are for its own routes.
 *
 * @example
 * import Fastify from 'fastify';
 * import { applyOidc } from './oidc-provider/apply.js';
 *
 * const app = Fastify();
 * await applyOidc(app, { signingKeyProvider: yourProvider, config: { issuer: 'https://op.example.com' } });
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { createApp, providerRoutes, type OidcProviderOptions } from '../../oidc-provider/app.js';
import { toWebRequest } from '../node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

/** The methods every provider path is registered for; the provider answers 405 to those it does not serve. */
const METHODS: HTTPMethods[] = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

/**
 * 既存の Fastify のアプリに OP を組み込む。
 *
 * OP のパスとその下のパス（`providerRoutes()` の `subpaths`）を、どの HTTP メソッドでも受け付けるルートとして一つずつ登録する。
 * 各リクエストは、ボディをバイト列のまま Web 標準の `Request` に変換して OP のルーターに渡し、返った `Response` を `toFastifyReply()` で書き込む。
 * ルートは専用のプラグインの中に登録し、そのプラグインではボディを解析せずにバイト列のまま渡すので、インスタンスのほかのルートのボディの解析は変わらない。
 */
export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void> {
  const oidc = createApp(options);
  // OP 自身のオリジンには、公開している `issuer` を使う（OIDC Discovery 1.0 §3）。
  // `node-adapter.ts` は、リクエストの `Host` ヘッダーから求めたオリジンを使わず、この値に置き換える。
  // `issuer` が設定されていなければ `http://localhost` を使う。
  const baseUrl = options.config?.issuer ?? 'http://localhost';

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = Buffer.isBuffer(request.body)
      ? (request.body.buffer.slice(
          request.body.byteOffset,
          request.body.byteOffset + request.body.byteLength,
        ) as ArrayBuffer)
      : undefined;
    const response = await oidc.request(toWebRequest(request.raw, baseUrl, body));
    await toFastifyReply(reply, response);
  };

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    for (const route of providerRoutes()) {
      const paths = [route.path, ...Object.keys(route.subpaths ?? {}).map((subpath) => route.path + subpath)];
      for (const url of paths) {
        scope.route({ method: METHODS, url, handler: handle, exposeHeadRoute: false });
      }
    }
  });
}

/**
 * `Response` を Fastify の `reply` に書き込んで送る。
 *
 * ステータスコード、ヘッダー（`Set-Cookie` は一つずつ別のヘッダーにする）、最後まで読んだボディを書き込む。
 * 空のボディはボディなしで送るので、Fastify は `Content-Type: application/octet-stream` を付けない。
 */
async function toFastifyReply(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    reply.header('Set-Cookie', setCookies);
  }
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    reply.header(name, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  // 空のボディは、ボディなしで送る。
  // 空の `Buffer` を渡すと、`application/octet-stream` として送られてしまう。
  reply.send(body.byteLength === 0 ? undefined : body);
}
