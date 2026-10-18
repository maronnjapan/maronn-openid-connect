/**
 * EXPERIMENTAL — Client Registration Endpoint (RFC 7591 §3).
 *
 * Generated because the OP was created with
 * `--enable dynamic-client-registration`. Backed by @maronn-openid-connect/experimental,
 * whose API is NOT stable: it may change in a breaking way between releases.
 * Do not build production code on it without pinning the version.
 *
 * The client POSTs its metadata here as JSON and receives a freshly minted
 * client_id (and, for confidential clients, a client_secret) that works on
 * /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD); set initialAccessToken (register/config.ts) to
 * require a Bearer token.
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps of register/config.ts. Open registration grants
 * no trust: what an issued client can do stays bounded by the same validation
 * as a static client (PKCE, exact redirect_uri match, client authentication).
 */
import {
  ClientRegistrationError,
  buildClientRegistrationResponse,
  buildRegisteredClient,
  validateClientRegistrationRequest,
  verifyInitialAccessToken,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { dynamicClientStore } from '../../_oidc-provider/features/dynamic-client-registration/store';
import { clientCors, corsPreflight, withCors } from '../../_oidc-provider/http';
import { dynamicClientRegistrationConfig } from '../../_oidc-provider/features/dynamic-client-registration/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await registerClient(request));
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

async function registerClient(request: Request): Promise<Response> {
  const config = dynamicClientRegistrationConfig;

  // (1) Initial access token, checked before the body is read. The two 401
  // shapes follow RFC 6750 §3.1: no error code without credentials, and
  // error="invalid_token" for presented-but-wrong ones. Neither reflects
  // anything about the expected token.
  if (config.initialAccessToken !== undefined) {
    const authorization = request.headers.get('Authorization');
    if (authorization === null) {
      return registration401('Bearer');
    }
    const accepted = await verifyInitialAccessToken(authorization, config.initialAccessToken);
    if (!accepted) {
      return registration401('Bearer error="invalid_token"');
    }
  }

  // (2) RFC 7591 §3.1: application/json only (parameters such as charset are
  // fine). Enforcing the media type also closes the cross-origin text/plain
  // form post that can synthesize a JSON-shaped body without a CORS preflight.
  if (!isJson(request.headers.get('Content-Type') ?? '')) {
    return registrationJson(
      { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
      400,
    );
  }

  const rawBody = await request.text();
  try {
    // (3)–(8) Body size, JSON shape, allowlist-pick of the understood fields,
    // value checks and RFC 7591 §2 defaults — pure functions from
    // @maronn-openid-connect/experimental/dynamic-client-registration. Unknown metadata is
    // silently ignored (§2 MUST), and every error_description is a fixed ASCII
    // string that never reflects request values.
    const metadata = validateClientRegistrationRequest(rawBody, {
      maxBodyBytes: config.maxRegistrationBodyBytes,
    });
    const client = buildRegisteredClient(metadata);

    // (9) Inventory cap (RFC 7591 §5). 429 with a fixed body: the metadata is
    // fine, so answering invalid_client_metadata would invite a retry loop that
    // amplifies the very DoS surface the cap is here to close. No Retry-After —
    // the cap is a stock ceiling, not a rate, so no recovery time is promised.
    if ((await dynamicClientStore.count()) >= config.maxRegisteredClients) {
      return registrationJson(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }
    await dynamicClientStore.save(client);

    // Never log the registration metadata or the issued client_secret.

    // RFC 7591 §3.2.1: 201 Created with the issued values and every registered
    // metadata value (defaults applied). client_secret_expires_at: 0 means the
    // secret does not expire.
    return registrationJson(buildClientRegistrationResponse(client), 201);
  } catch (error) {
    if (error instanceof ClientRegistrationError) {
      // RFC 7591 §3.2.2: 400 with error / error_description JSON.
      return registrationJson({ error: error.error, error_description: error.errorDescription }, 400);
    }
    return registrationJson({ error: 'server_error' }, 500);
  }
}

/** RFC 7591 §3.1: the registration request body MUST be application/json. */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/** The 201 body carries the client_secret, so no registration response may be cached. */
function registrationJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

/** RFC 6750 §3.1: a 401 challenge with an empty body. */
function registration401(wwwAuthenticate: string): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': wwwAuthenticate,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
