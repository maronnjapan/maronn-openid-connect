/**
 * Apply the OpenID Connect Provider to a Fastify instance.
 *
 * Every path the provider serves (providerRoutes() of app.ts: the endpoints
 * of every provider and those of the generated features, with the paths below
 * them) is registered with its methods and OPTIONS (the CORS preflight), and
 * handed to the provider's router. Fastify matches paths exactly, so the paths
 * below a mount point (/device/login, ...) are registered one by one.
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

export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void> {
  const oidc = createApp(options);
  // The advertised issuer is the source of truth for the OP's own origin
  // (OIDC Discovery 1.0 §3); the node adapter drops the request's Host-derived
  // origin in favor of this value.
  const baseUrl = options.config?.issuer ?? 'http://localhost';

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

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

  for (const route of providerRoutes()) {
    app.route({ method: withPreflight(route.methods), url: route.path, handler: handle });
    for (const [subpath, methods] of Object.entries(route.subpaths ?? {})) {
      app.route({ method: withPreflight(methods), url: route.path + subpath, handler: handle });
    }
  }
}

/** The methods of a path, with OPTIONS for the CORS preflight the provider answers. */
function withPreflight(methods: readonly string[]): HTTPMethods[] {
  return [...new Set([...methods, 'OPTIONS'])] as HTTPMethods[];
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
  reply.send(Buffer.from(await response.arrayBuffer()));
}
