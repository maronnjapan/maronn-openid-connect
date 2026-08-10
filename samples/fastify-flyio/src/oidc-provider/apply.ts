import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createApp, type OidcProviderOptions } from './app.js';
import { toWebRequest } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

export async function applyOidc(app: FastifyInstance, options: ApplyOidcOptions): Promise<void> {
  const oidc = createApp(options);
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
      ? request.body.buffer.slice(
          request.body.byteOffset,
          request.body.byteOffset + request.body.byteLength,
        ) as ArrayBuffer
      : undefined;
    const response = await oidc.request(toWebRequest(request.raw, baseUrl, body));
    await toFastifyReply(reply, response);
  };

  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/authorize', handler: handle });
  app.route({ method: ['POST', 'OPTIONS'], url: '/token', handler: handle });
  app.route({ method: ['GET', 'POST', 'OPTIONS'], url: '/userinfo', handler: handle });
  app.route({ method: ['POST', 'OPTIONS'], url: '/introspect', handler: handle });
  app.route({ method: ['POST', 'OPTIONS'], url: '/revoke', handler: handle });
  app.route({ method: ['POST', 'OPTIONS'], url: '/device_authorization', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/device', handler: handle });
  app.route({ method: ['POST'], url: '/device/login', handler: handle });
  app.route({ method: ['POST'], url: '/device/approve', handler: handle });
  app.route({ method: ['GET', 'OPTIONS'], url: '/.well-known/jwks.json', handler: handle });
  app.route({ method: ['GET', 'OPTIONS'], url: '/.well-known/openid-configuration', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/login', handler: handle });
  app.route({ method: ['GET', 'POST'], url: '/consent', handler: handle });
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
