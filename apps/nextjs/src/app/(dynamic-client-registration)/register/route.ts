/**
 * EXPERIMENTAL — Client Registration Endpoint (RFC 7591 §3).
 *
 * Generated because the OP was created with
 * `--enable dynamic-client-registration`. Backed by @maronn-openid-connect/experimental,
 * whose API is NOT stable: it may change in a breaking way between releases.
 * Do not build production code on it without pinning the version.
 *
 * The client POSTs its metadata here as JSON — optionally bundled in a signed
 * software statement of a publisher this OP trusts — and receives a freshly
 * minted client_id (and, for confidential clients, a client_secret) that works
 * on /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD) and a software_statement is ignored (§3.1.1); set
 * verifyInitialAccessToken / verifySoftwareStatement of
 * dynamicClientRegistrationConfig
 * (_oidc-provider/features/dynamic-client-registration/config.ts) to require
 * them and verify them with functions of your own — this code verifies
 * neither. Metadata beyond the standard fields is accepted through
 * customClientMetadata of the same config.
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps of that config.ts. Open registration grants no
 * trust: what an issued client can do stays bounded by the same validation as
 * a static client (PKCE, exact redirect_uri match, client authentication).
 */
import { getJwaAlgorithm, hashClientSecret, responseTypeIncludes, type SigningKey } from '@maronn-openid-connect/core';
import {
  applySoftwareStatement,
  buildClientRegistrationResponse,
  buildRegisteredClient,
  ClientRegistrationError,
  isClientRegistrationError,
  parseClientRegistrationBody,
  readBearerToken,
  validateClientMetadata,
  type ParsedClientRegistration,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { discoveryOf, responseTypesOf, tokenGrantsOf } from '../../_oidc-provider/feature';
import { features } from '../../_oidc-provider/features';
import {
  dynamicClientRegistrationConfig,
  type DynamicClientRegistrationConfig,
} from '../../_oidc-provider/features/dynamic-client-registration/config';
import {
  dynamicClientStore,
  toClientRegistration,
} from '../../_oidc-provider/features/dynamic-client-registration/store';
import { clientCors, corsPreflight, signingKeysUnavailable, withCors } from '../../_oidc-provider/http';
import { config as providerConfig, loadSigningKeys } from '../../_oidc-provider/provider';
import { CUSTOM_SCOPES, STANDARD_SCOPES } from '../../_oidc-provider/scopes';

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

  // (1) May the request register? Open registration while the config sets no
  // verifyInitialAccessToken (RFC 7591 §3.1 SHOULD). With one, the request
  // must carry a Bearer token (RFC 6750 §2.1) — a bare 401 challenge without
  // one, as RFC 6750 §3.1 asks for a request without credentials — and the
  // configured function decides whether that token may register (401
  // error="invalid_token" when it says no). Nothing here verifies the token
  // itself, and neither response reflects anything about the expected token.
  if (config.verifyInitialAccessToken !== undefined) {
    const token = readBearerToken(request.headers.get('Authorization'));
    if (token === undefined) return registration401('Bearer');
    if (!(await config.verifyInitialAccessToken(token, config))) {
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

  // A Content-Length that already declares more than maxRegistrationBodyBytes
  // is refused before the body is read, so an oversized request is not
  // buffered first. The header can lie, so the authoritative check stays the
  // UTF-8 byte count on the body itself (parseClientRegistrationBody).
  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > config.maxRegistrationBodyBytes) {
    return registrationJson(
      { error: 'invalid_client_metadata', error_description: 'request body must not exceed the configured maximum size' },
      400,
    );
  }

  // The signed response algs a client may register are those of the signing
  // keys, as discovery advertises them.
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  try {
    // The body read sits inside the try so that an aborted or malformed
    // transfer still gets the fixed server_error JSON with no-store, like the
    // hono pipeline, instead of the framework's default 500.
    const rawBody = await request.text();

    // (3) Body size, JSON shape; a software_statement (RFC 7591 §2.3) is split
    // from the plain metadata.
    const registration = parseClientRegistrationBody(rawBody, { maxBodyBytes: config.maxRegistrationBodyBytes });

    // (4) RFC 7591 §3.1.1: without a verifySoftwareStatement in the config this
    // provider does not support software statements and ignores the member, as
    // §3.1.1 allows. With one, every registration must carry a
    // software_statement (invalid_client_metadata without it); the function
    // verifies it — RFC 7591 leaves the trust criteria to the server, so
    // nothing here examines the statement — and rejects with
    // invalid_software_statement or unapproved_software_statement (§3.2.2).
    // The metadata it returns is applied over the plain values, and the
    // statement comes back unmodified in the response (§3.2.1).
    const metadata = await resolveRegistrationMetadata(config, registration);

    // (5) Allowlist-pick of the understood fields, value checks, the RFC 7591
    // §2 and OIDC Dynamic Client Registration 1.0 §2 defaults (application_type
    // web, id_token_signed_response_alg RS256 — registered and returned, §3.2),
    // the redirect_uris constraints of the application type and the §2.1
    // consistency of grant_types and response_types — pure functions from
    // @maronn-openid-connect/experimental/dynamic-client-registration, bounded
    // to what this provider answers: the methods and grants of the config, the
    // response types of the features, the scopes of scopes.ts, the algs of the
    // signing keys, the Request Object signing algs the request-object feature
    // advertises (request_uris are kept for /authorize to match, and a
    // jwks_uri for the key resolver to fetch; neither is fetched here) and the
    // custom metadata of the config. Unknown metadata is
    // silently ignored (§2 MUST), and every error_description is a fixed ASCII
    // string that never reflects request values.
    const responseTypes = ['code', ...responseTypesOf(features)];
    const validated = validateClientMetadata(metadata, {
      tokenEndpointAuthMethods: config.tokenEndpointAuthMethods,
      grantTypes: registrableGrantTypes(config.grantTypes, responseTypes),
      responseTypes,
      scopes: registrableScopes(),
      idTokenSigningAlgValuesSupported: signingAlgsOf(keys.idToken),
      userinfoSigningAlgValuesSupported: signingAlgsOf(keys.userinfo),
      requestObjectSigningAlgValuesSupported: requestObjectSigningAlgs(),
      allowJwksUri: config.allowJwksUri,
      customMetadata: config.customClientMetadata,
    });
    const client = buildRegisteredClient(validated);

    // (6) Inventory cap (RFC 7591 §5). 429 with a fixed body: the metadata is
    // fine, so answering invalid_client_metadata would invite a retry loop that
    // amplifies the very DoS surface the cap is here to close. No Retry-After —
    // the cap is a stock ceiling, not a rate, so no recovery time is promised.
    if ((await dynamicClientStore.count()) >= config.maxRegisteredClients) {
      return registrationJson(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }

    // The stored record (toClientRegistration) keeps the client_secret only as
    // its hash, like the statically registered clients (_oidc-provider/db
    // registerClient), and the keys of the jwks under the purposes of the
    // config: the 201 response below is built from the in-memory record, so the
    // plaintext never needs to rest in the store.
    const clientSecretHash = client.clientSecret === undefined ? undefined : await hashClientSecret(client.clientSecret);
    await dynamicClientStore.save(toClientRegistration(client, { clientSecretHash, jwksPurposes: config.jwksPurposes }));
    // Concurrent requests can pass the cap check together (the awaits above let
    // them interleave), so re-check after saving and withdraw this registration
    // when the save overshot the cap: the cap is never exceeded, only approached.
    if ((await dynamicClientStore.count()) > config.maxRegisteredClients) {
      await dynamicClientStore.delete(client.clientId);
      return registrationJson(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }

    // Never log the registration metadata or the issued client_secret.

    // RFC 7591 §3.2.1: 201 Created with the issued values and every registered
    // metadata value (defaults applied). client_secret_expires_at: 0 means the
    // secret does not expire.
    return registrationJson(buildClientRegistrationResponse(client), 201);
  } catch (error) {
    // RFC 7591 §3.2.2: 400 with error / error_description JSON. The error is
    // told apart by shape, not by class: the verifier functions of config.ts
    // may be set where the app starts (instrumentation.ts), which Next.js
    // bundles apart from this Route Handler, so their ClientRegistrationError
    // is another copy of the class.
    if (isClientRegistrationError(error)) {
      return registrationJson({ error: error.error, error_description: error.errorDescription }, 400);
    }
    return registrationJson({ error: 'server_error' }, 500);
  }
}

/**
 * The metadata to register: the plain values, with those a verified software
 * statement asserts taking precedence (RFC 7591 §3.1.1). Without a verifier the
 * provider does not support software statements and ignores the member; with
 * one the statement is required and the verifier alone judges it.
 */
async function resolveRegistrationMetadata(
  config: DynamicClientRegistrationConfig,
  registration: ParsedClientRegistration,
): Promise<Record<string, unknown>> {
  if (config.verifySoftwareStatement === undefined) {
    return registration.metadata;
  }
  if (registration.softwareStatement === undefined) {
    throw new ClientRegistrationError('invalid_client_metadata', 'software_statement is required');
  }
  const verified = await config.verifySoftwareStatement(registration.softwareStatement, config);
  return applySoftwareStatement(registration.metadata, registration.softwareStatement, verified);
}

/**
 * The grant_type values of the registration config that this provider answers
 * (RFC 7591 §2): authorization_code always, the grants the generated features
 * answer at the token endpoint, and implicit while a feature answers a token or
 * id_token response type at /authorize (OIDC Dynamic Client Registration 1.0 §2
 * pairs them). A grant the provider does not answer is never registrable: a
 * client registered for it could not use it.
 */
export function registrableGrantTypes(configured: readonly string[], responseTypes: readonly string[]): string[] {
  const offered = ['authorization_code', ...tokenGrantsOf(features)];
  const answersImplicit = responseTypes.some(
    (responseType) => responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token'),
  );
  if (answersImplicit) offered.push('implicit');
  return configured.filter((grantType) => offered.includes(grantType));
}

/**
 * scopes.ts: once a custom scope is declared, a registration may name only the
 * standard and the declared scopes (what findUnsupportedScopes() accepts at
 * /authorize); without one there is no list, and any syntactically valid value
 * registers.
 */
export function registrableScopes(): readonly string[] | undefined {
  return CUSTOM_SCOPES.length === 0 ? undefined : [...STANDARD_SCOPES, ...CUSTOM_SCOPES];
}

/** The JWA algs of a registered signing key set, each once (what discovery advertises for it). */
function signingAlgsOf(keys: readonly SigningKey[]): string[] {
  return [...new Set(keys.map((key) => getJwaAlgorithm(key.privateKey)))];
}

/**
 * The request_object_signing_alg values a registration may name: what the
 * request-object feature advertises as request_object_signing_alg_values_supported
 * (RS256, and none while unsigned Request Objects are accepted), so a client
 * cannot register an alg the authorization endpoint would then reject. RS256
 * alone without the feature.
 */
export function requestObjectSigningAlgs(): readonly string[] {
  const advertised = discoveryOf(features, {}, providerConfig.issuer, providerConfig)[
    'request_object_signing_alg_values_supported'
  ];
  return Array.isArray(advertised) ? (advertised as string[]) : ['RS256'];
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
