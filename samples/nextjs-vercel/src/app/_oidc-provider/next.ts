import { createApp, type OidcProviderOptions } from './app';

export type NextOidcProviderOptions = OidcProviderOptions;
export type NextOidcRouteHandler = (request: Request) => Promise<Response>;

export interface NextOidcRouteHandlers {
  GET: NextOidcRouteHandler;
  POST: NextOidcRouteHandler;
  OPTIONS: NextOidcRouteHandler;
}

export function createOidcRouteHandlers(options: NextOidcProviderOptions): NextOidcRouteHandlers {
  const oidc = createApp(options);
  const handle = (request: Request): Promise<Response> =>
    oidc.request(rebaseRequestOrigin(request, options.config?.issuer));

  return {
    GET: handle,
    POST: handle,
    OPTIONS: handle,
  };
}

// The advertised issuer is the source of truth for the OP's own origin
// (OIDC Discovery 1.0 §3): rebasing here keeps every URL the OP derives from
// the request — including the /login and /consent redirect Locations —
// independent of the Host header the runtime saw (RFC 9700 §2.1).
function rebaseRequestOrigin(request: Request, issuer: string | undefined): Request {
  if (!issuer) return request;

  const issuerUrl = new URL(issuer);
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === issuerUrl.origin) return request;

  requestUrl.protocol = issuerUrl.protocol;
  requestUrl.host = issuerUrl.host;
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.body) {
    init.duplex = 'half';
  }
  return new Request(requestUrl, init);
}
