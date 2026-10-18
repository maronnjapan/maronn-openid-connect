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

export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void> {
  const oidc = createApp(options);
  // The advertised issuer is the source of truth for the OP's own origin
  // (OIDC Discovery 1.0 §3); the node adapter drops the request's Host-derived
  // origin in favor of this value.
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
  // An empty Buffer would be sent as application/octet-stream.
  reply.send(body.byteLength === 0 ? undefined : body);
}
