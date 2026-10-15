/**
 * EXPERIMENTAL — Dynamic Client Registration (RFC 7591).
 *
 * This route was generated because the OP was created with
 * `--enable dynamic-client-registration`. It is backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The client POSTs its metadata here as JSON and receives a freshly minted
 * client_id (and, for confidential clients, a client_secret) that works on
 * /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD); set initialAccessToken to require a Bearer token.
 */
import { Hono } from 'hono';
import {
  ClientRegistrationError,
  buildClientRegistrationResponse,
  buildRegisteredClient,
  validateClientRegistrationRequest,
  verifyInitialAccessToken,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { dynamicClientStore as defaultDynamicClientStore } from '../store.js';

/**
 * Dynamic client registration settings. apply.ts merges the applyOidc option
 * override over these defaults, so change them here or per deployment there.
 *
 * - initialAccessToken: when set, POST /register requires
 *   `Authorization: Bearer <value>` (OIDC Dynamic Client Registration 1.0 §3).
 *   Unset means open registration (RFC 7591 §3.1 SHOULD). This is one static
 *   secret for PoC use — there is no issuance or rotation.
 * - maxRegisteredClients: inventory cap on dynamic registrations
 *   (RFC 7591 §5 DoS consideration). The cap answers 429, not
 *   invalid_client_metadata: nothing about the metadata is wrong, so a
 *   metadata-retry loop must not be invited.
 * - maxRegistrationBodyBytes: request body limit in UTF-8 bytes.
 */
export const dynamicClientRegistrationConfig = {
  initialAccessToken: undefined as string | undefined,
  maxRegisteredClients: 100,
  maxRegistrationBodyBytes: 16384,
};

export const registerApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 7591 §3.1: the registration request body MUST be application/json.
 * Enforcing the media type also closes the cross-origin text/plain form post
 * that can synthesize a JSON-shaped body without a CORS preflight.
 */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/**
 * Client Registration Endpoint
 * RFC 7591 §3
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps above. Open registration grants no trust: what
 * an issued client can do stays bounded by the same validation as a static
 * client (PKCE, exact redirect_uri match, client authentication).
 */
registerApp.post('/', async (c) => {
  // The 201 body carries the client_secret, so it must never be cached.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  const config = c.get('dynamicClientRegistrationConfig') ?? dynamicClientRegistrationConfig;
  const store = c.get('dynamicClientStore') ?? defaultDynamicClientStore;

  // (1) Initial access token, checked before the body is read. The two 401
  // shapes follow RFC 6750 §3.1: no error code without credentials, and
  // error="invalid_token" for presented-but-wrong ones. Neither reflects
  // anything about the expected token.
  if (config.initialAccessToken !== undefined) {
    const authorization = c.req.header('Authorization');
    if (authorization === undefined) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.body(null, 401);
    }
    const accepted = await verifyInitialAccessToken(authorization, config.initialAccessToken);
    if (!accepted) {
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.body(null, 401);
    }
  }

  // (2) RFC 7591 §3.1: application/json only (parameters such as charset are fine).
  if (!isJson(c.req.header('Content-Type') ?? '')) {
    return c.json(
      { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
      400,
    );
  }

  const rawBody = await c.req.text();
  try {
    // (3)–(8) Body size, JSON shape, allowlist-pick of the understood fields,
    // value checks and RFC 7591 §2 defaults — pure functions from
    // @maronn-openid-connect/experimental/dynamic-client-registration. Unknown metadata is
    // silently ignored (§2 MUST), and every error_description is a fixed ASCII
    // string that never reflects request values. A registered `scope`
    // (RFC 7591 §2) becomes the client's per-client allow list: requests for
    // any other scope fail with invalid_scope, like a static client's.
    const metadata = validateClientRegistrationRequest(rawBody, {
      maxBodyBytes: config.maxRegistrationBodyBytes,
    });
    const client = buildRegisteredClient(metadata);

    // (9) Inventory cap (RFC 7591 §5). 429 with a fixed body: the metadata is
    // fine, so answering invalid_client_metadata would invite a retry loop that
    // amplifies the very DoS surface the cap is here to close. No Retry-After —
    // the cap is a stock ceiling, not a rate, so no recovery time is promised.
    if ((await store.count()) >= config.maxRegisteredClients) {
      return c.json(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }
    await store.save(client);

    // Never log the registration metadata or the issued client_secret.

    // RFC 7591 §3.2.1: 201 Created with the issued values and every registered
    // metadata value (defaults applied). client_secret_expires_at: 0 means the
    // secret does not expire.
    return c.json(buildClientRegistrationResponse(client), 201);
  } catch (error) {
    if (error instanceof ClientRegistrationError) {
      // RFC 7591 §3.2.2: 400 with error / error_description JSON.
      return c.json({ error: error.error, error_description: error.errorDescription }, 400);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
