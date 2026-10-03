/**
 * Helpers shared by the OP's Route Handlers.
 *
 * - CORS: the back-channel endpoints may be called from client applications in
 *   the browser; discovery and JWKS are public. Each Route Handler exports an
 *   OPTIONS handler (corsPreflight) and wraps its answers with withCors.
 * - Responses that carry credentials are never cached (RFC 6749 §5.1 / §5.2).
 * - OAuth request parameters must not be repeated (RFC 6749 §3.1 / §3.2), which
 *   Object.fromEntries(searchParams) would hide by keeping only the last value.
 */
import { corsOrigins } from './provider';

export interface CorsPolicy {
  origins: string | readonly string[];
  allowMethods: readonly string[];
  allowHeaders: readonly string[];
  maxAge: number;
}

/**
 * Endpoints client applications call directly (token, userinfo, introspect,
 * revoke, ...): only the origins configured in provider.ts.
 */
export const clientCors: CorsPolicy = {
  origins: corsOrigins,
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
};

/** Public metadata (discovery, JWKS): readable from any origin. */
export const publicCors: CorsPolicy = {
  origins: '*',
  allowMethods: ['GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 600,
};

/** Answer a CORS preflight request. */
export function corsPreflight(request: Request, policy: CorsPolicy): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, policy) });
}

/** Add the CORS headers of policy to a response. */
export function withCors(request: Request, policy: CorsPolicy, response: Response): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, policy).forEach((value, name) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request: Request, policy: CorsPolicy): Headers {
  const headers = new Headers();
  const origin = allowedOrigin(request.headers.get('Origin'), policy.origins);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', policy.allowMethods.join(','));
  headers.set('Access-Control-Allow-Headers', policy.allowHeaders.join(','));
  headers.set('Access-Control-Max-Age', String(policy.maxAge));
  return headers;
}

function allowedOrigin(
  requestOrigin: string | null,
  allowed: string | readonly string[],
): string | undefined {
  if (typeof allowed === 'string') return allowed;
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

/**
 * A JSON response that must never be stored: token, introspection and the
 * other credential-bearing responses (RFC 6749 §5.1 / §5.2).
 */
export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  return Response.json(body, { ...init, headers });
}

/** An OAuth error response (RFC 6749 §5.2), never cached. */
export function oauthError(
  error: string,
  errorDescription: string | undefined,
  status = 400,
  headers?: HeadersInit,
): Response {
  return noStoreJson({ error, error_description: errorDescription }, { status, headers });
}

/**
 * The signing keys could not be loaded or failed validation (a key provider
 * outage, or a key set the OP must not sign with).
 */
export function signingKeysUnavailable(): Response {
  return Response.json(
    { error: 'server_error', error_description: 'Failed to load signing key' },
    { status: 503 },
  );
}

/**
 * Is the request body application/x-www-form-urlencoded? Media types are
 * case-insensitive and may carry parameters such as "; charset=UTF-8"
 * (RFC 9110 §8.3.1).
 */
export function isFormUrlEncoded(request: Request): boolean {
  const [mediaType = ''] = (request.headers.get('Content-Type') ?? '').toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/** Request parameters, and the first name that was repeated (if any). */
export interface UniqueParams {
  params: Record<string, string>;
  duplicateKey?: string;
}

/** Collect parameters, stopping at the first repeated name (RFC 6749 §3.1 / §3.2). */
export function uniqueParams(searchParams: URLSearchParams): UniqueParams {
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      return { params, duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }
  return { params };
}
