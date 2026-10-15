import { Hono } from 'hono';
import { dynamicClientStore as defaultDynamicClientStore } from '../store.js';
import {
  verifyInitialAccessToken,
  buildRegisteredClient,
  validateClientRegistrationRequest,
  type DynamicallyRegisteredClient,
  buildClientRegistrationResponse,
  ClientRegistrationError,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';

/**
 * EXPERIMENTAL — Dynamic Client Registration (RFC 7591).
 *
 * This route was generated because the OP was created with
 * `--enable dynamic-client-registration`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs its metadata here as JSON and receives a freshly minted
 * client_id (and, for confidential clients, a client_secret) that works on
 * /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD); set initialAccessToken to require a Bearer token.
 * Every function exported below is one box of the endpoint's pipeline
 * (`maronn-oidc graph --detail steps --endpoint register`).
 */

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

/** What the client registration endpoint answers; respondRegistration() turns it into HTTP. */
export interface RegistrationEndpointResponse {
  status: number;
  body: object | null;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class RegistrationEndpointError extends Error {
  constructor(readonly response: RegistrationEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'client registration endpoint error'));
    this.name = 'RegistrationEndpointError';
  }
}

export const registerApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 7591 §3.1: the registration request body MUST be application/json.
 */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/**
 * Check the initial access token when one is configured, before the body is
 * read. OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1
 *
 * The two 401 shapes follow RFC 6750 §3.1: no error code without credentials,
 * and error="invalid_token" for presented-but-wrong ones. Neither reflects
 * anything about the expected token.
 */
export async function verifyRegistrationAccess(c: any): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig') ?? dynamicClientRegistrationConfig;
  if (config.initialAccessToken === undefined) return;
  const authorization = c.req.header('Authorization');
  if (authorization === undefined) {
    throw new RegistrationEndpointError({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  const accepted = await verifyInitialAccessToken(authorization, config.initialAccessToken);
  if (!accepted) {
    throw new RegistrationEndpointError({
      status: 401,
      body: null,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    });
  }
}

/**
 * RFC 7591 §3.1: the registration request body MUST be application/json
 * (parameters such as charset are fine). Enforcing the media type also closes
 * the cross-origin text/plain form post that can synthesize a JSON-shaped body
 * without a CORS preflight.
 */
export async function parseRegistrationRequest(c: any): Promise<string> {
  if (!isJson(c.req.header('Content-Type') ?? '')) {
    throw new RegistrationEndpointError({
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
    });
  }
  return c.req.text();
}

/**
 * Body size, JSON shape, allowlist-pick of the understood fields, value checks
 * and RFC 7591 §2 defaults — pure functions from the experimental package.
 * Unknown metadata is silently ignored (§2 MUST), and every error_description
 * is a fixed ASCII string that never reflects request values.
 */
export function validateRegistrationMetadata(c: any, rawBody: string): DynamicallyRegisteredClient {
  const config = c.get('dynamicClientRegistrationConfig') ?? dynamicClientRegistrationConfig;
  const metadata = validateClientRegistrationRequest(rawBody, {
    maxBodyBytes: config.maxRegistrationBodyBytes,
  });
  return buildRegisteredClient(metadata);
}

/**
 * Enforce the inventory cap (RFC 7591 §5) and store the client. 429 with a
 * fixed body: the metadata is fine, so answering invalid_client_metadata would
 * invite a retry loop that amplifies the very DoS surface the cap is here to
 * close. No Retry-After — the cap is a stock ceiling, not a rate, so no
 * recovery time is promised.
 */
export async function storeRegisteredClient(c: any, client: DynamicallyRegisteredClient): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig') ?? dynamicClientRegistrationConfig;
  const store = c.get('dynamicClientStore') ?? defaultDynamicClientStore;
  if ((await store.count()) >= config.maxRegisteredClients) {
    throw new RegistrationEndpointError({
      status: 429,
      body: { error: 'too_many_registrations', error_description: 'registration limit reached' },
    });
  }
  await store.save(client);
  // Never log the registration metadata or the issued client_secret.
}

/**
 * RFC 7591 §3.2.1: 201 Created with the issued values and every registered
 * metadata value (defaults applied). client_secret_expires_at: 0 means the
 * secret does not expire. The body carries the client_secret, so it is never
 * cached.
 */
export function respondRegistration(c: any, client: DynamicallyRegisteredClient): Response {
  return sendRegistrationResponse(c, { status: 201, body: buildClientRegistrationResponse(client) });
}

function sendRegistrationResponse(c: any, response: RegistrationEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  if (response.body === null) {
    return c.body(null, response.status);
  }
  return c.json(response.body, response.status);
}

/**
 * RFC 7591 §3.2.2: 400 with error / error_description JSON for invalid
 * metadata; the fixed responses of the earlier steps (401, 429) as they are.
 */
export function respondRegistrationError(c: any, error: unknown): Response {
  if (error instanceof RegistrationEndpointError) {
    return sendRegistrationResponse(c, error.response);
  }
  if (error instanceof ClientRegistrationError) {
    return sendRegistrationResponse(c, {
      status: 400,
      body: { error: error.error, error_description: error.errorDescription },
    });
  }
  return sendRegistrationResponse(c, { status: 500, body: { error: 'server_error' } });
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
  try {
    // [verify-initial-access-token] Check the initial access token, if one is required — OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1
    await verifyRegistrationAccess(c);

    // [parse-request] Read the JSON metadata — RFC 7591 §3.1
    const rawBody = await parseRegistrationRequest(c);

    // [validate-metadata] Validate the metadata and build the client — RFC 7591 §2 / §3.1
    const client = validateRegistrationMetadata(c, rawBody);

    // [store-client] Enforce the inventory cap and store the client — RFC 7591 §5
    await storeRegisteredClient(c, client);

    // [respond] Respond 201 with the registration response — RFC 7591 §3.2.1
    return respondRegistration(c, client);
  } catch (error) {
    return respondRegistrationError(c, error);
  }
});
