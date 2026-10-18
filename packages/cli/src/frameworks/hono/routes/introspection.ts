/**
 * Token introspection endpoint (`routes/introspection.ts`) for the hono /
 * express / fastify output: one fragment per step of the `introspection`
 * endpoint of the flow catalog.
 */
import { DEFAULT_FEATURES } from '../../../registry.js';
import type { OidcFeatureConfig } from '../../../registry.js';
import { buildOpFlow } from '../../../flow/catalog.js';
import { EXPERIMENTAL_PACKAGE } from '../../packages.js';
import { renderPipelineRoute, type StepFragment } from '../pipeline.js';

const HEADER = `/**
 * Token Introspection endpoint (API layer).
 * RFC 7662 Section 2
 *
 * Every function exported below is one box of the introspection endpoint's
 * pipeline (\`maronn-oidc graph --detail steps --endpoint introspection\`):
 * parse the request, authenticate the confidential client, resolve the token,
 * describe it, and answer. The handler at the bottom calls them in order.
 *
 * Confidential client only — a caller registered with
 * token_endpoint_auth_method 'none' is rejected with invalid_client
 * (RFC 7662 §2.1 / RFC 9701 §5), because a public client_id alone is not
 * authentication. Response is always cache-busting per RFC 7662 Section 2.2.
 */

/** What the introspection endpoint answers; respondIntrospection() turns it into HTTP. */
export interface IntrospectionEndpointResponse {
  status: number;
  /** A JSON body (application/json). */
  body?: object;
  /** A raw body with its own Content-Type (the signed JWT of RFC 9701). */
  text?: string;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class IntrospectionEndpointError extends Error {
  constructor(readonly response: IntrospectionEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'introspection endpoint error'));
    this.name = 'IntrospectionEndpointError';
  }
}

export const introspectionApp = new Hono<{ Variables: Record<string, any> }>();

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}`;

const PARSE_REQUEST: StepFragment = {
  definition: `/**
 * Parse the introspection request: the form body and the Authorization header.
 * RFC 7662 §2.1 (the body MUST be application/x-www-form-urlencoded)
 */
export async function parseIntrospectionRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    throw new IntrospectionEndpointError({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Content-Type must be application/x-www-form-urlencoded' },
    });
  }
  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );
  return { params, authorization };
}`,
  call: { bind: ['params', 'authorization'], expression: 'await parseIntrospectionRequest(c)' },
};

const AUTHENTICATE_CLIENT: StepFragment = {
  imports: {
    core: [
      'extractClientCredentials',
      'resolveAuthenticatedTokenClient',
      'validateClientAuthMethod',
      'verifyClientSecret',
      'requireConfidentialIntrospectionCaller',
    ],
    resolvers: ['tokenClientResolver as defaultTokenClientResolver'],
  },
  definition: `/**
 * Authenticate the caller — the same steps as the token endpoint
 * (OAuth 2.1 §2.3 / OIDC Core 1.0 §9) — and require a confidential client.
 * RFC 7662 §2.1 / RFC 9701 §5
 *
 * A client registered with token_endpoint_auth_method 'none' passes the
 * pipeline by presenting its client_id alone — public information — so
 * treating it as authenticated would let anyone scan tokens. Revocation
 * deliberately has no such step: RFC 7009 §2.1 lets a public client revoke
 * its own tokens.
 */
export async function authenticateIntrospectionClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<string> {
  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const introspectingClient = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(introspectingClient, presentedCredentials);
  await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
  requireConfidentialIntrospectionCaller(introspectingClient);
  return presentedCredentials.clientId;
}`,
  call: {
    bind: 'authenticatedClientId',
    expression: 'await authenticateIntrospectionClient(c, params, authorization)',
  },
};

const RESOLVE_TOKEN: StepFragment = {
  imports: {
    core: [
      'requireIntrospectionToken',
      'requireIntrospectionClient',
      'resolveIntrospectionToken',
      'type ResolvedIntrospectionToken',
    ],
    resolvers: [
      'introspectionAccessTokenResolver as defaultAccessResolver',
      'introspectionRefreshTokenResolver as defaultRefreshResolver',
    ],
  },
  definition: `/**
 * Resolve the presented token (access or refresh token); null when unknown.
 * RFC 7662 §2.1
 *
 * Each check is an independent core function. token_type_hint only reorders
 * the lookup — the other token type is still searched when the hint misses.
 */
export async function resolveIntrospectedToken(
  c: any,
  params: Record<string, string>,
  authenticatedClientId: string,
): Promise<ResolvedIntrospectionToken | null> {
  const accessTokenResolver =
    c.get('introspectionAccessTokenResolver') ?? defaultAccessResolver;
  const refreshTokenResolver =
    c.get('introspectionRefreshTokenResolver') ?? defaultRefreshResolver;

  // RFC 7662 §2.1: token is REQUIRED (invalid_request when absent).
  const token = requireIntrospectionToken({
    token: typeof params.token === 'string' ? params.token : undefined,
  });

  // RFC 7662 §2.1: the caller must be an authenticated client (invalid_client).
  requireIntrospectionClient(authenticatedClientId);

  return resolveIntrospectionToken({
    token,
    tokenTypeHint:
      typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
    accessTokenResolver,
    refreshTokenResolver,
  });
}`,
  call: { bind: 'resolved', expression: 'await resolveIntrospectedToken(c, params, authenticatedClientId)' },
};

const BUILD_RESPONSE: StepFragment = {
  imports: {
    core: [
      'isIntrospectionTokenActive',
      'buildIntrospectionResponse',
      'INACTIVE_INTROSPECTION_RESPONSE',
      'type IntrospectionResponse',
      'type ResolvedIntrospectionToken',
    ],
  },
  definition: `/**
 * Describe the token. RFC 7662 §2.2: an unknown, expired, not-yet-valid or
 * rotated token is reported as { active: false } with no other member, so the
 * caller cannot distinguish "never existed" from "no longer valid".
 */
export function describeIntrospectedToken(resolved: ResolvedIntrospectionToken | null): IntrospectionResponse {
  if (resolved !== null && isIntrospectionTokenActive(resolved)) {
    return buildIntrospectionResponse(resolved);
  }
  return INACTIVE_INTROSPECTION_RESPONSE;
}`,
  call: { bind: 'introspection', expression: 'describeIntrospectedToken(resolved)' },
};

const SIGN_RESPONSE: StepFragment = {
  imports: {
    core: ['selectSigningKeyByAlg', 'type IntrospectionResponse', 'type SigningKey'],
    modules: {
      [`${EXPERIMENTAL_PACKAGE}/jwt-introspection-response`]: [
        'TOKEN_INTROSPECTION_JWT_MEDIA_TYPE',
        'acceptsIntrospectionJwt',
        'createIntrospectionResponseJwt',
        'restrictIntrospectionResponseToCaller',
      ],
    },
  },
  definition: `/**
 * EXPERIMENTAL — RFC 9701 §4 / §5: a caller whose Accept header names
 * application/token-introspection+jwt receives the introspection response as
 * a signed JWT. Any other request (no Accept, application/json, a wildcard)
 * returns undefined and is answered as before. The step sits AFTER client
 * authentication and token resolution so the Accept header can never bypass
 * either (§8.2 downgrade prevention).
 */
export async function signIntrospectionResponse(
  c: any,
  introspection: IntrospectionResponse,
  authenticatedClientId: string,
): Promise<IntrospectionEndpointResponse | undefined> {
  if (!acceptsIntrospectionJwt(c.req.header('Accept'))) return undefined;

  // RFC 9701 §3 / §5: before the response leaves as a signed assertion its
  // members are restricted to what the authenticated caller may see — a
  // caller that is neither the client the token was issued to nor listed in
  // its aud gets { active: false }, indistinguishable from an unknown token.
  const restrictedResponse = restrictIntrospectionResponseToCaller(
    introspection,
    authenticatedClientId,
  );
  // RFC 9701 §6: alg is pinned to RS256 (the default for a client that
  // registered no introspection_signed_response_alg). The first key of the
  // general-purpose set is not guaranteed to be RS256 — a SigningKeyProvider
  // may legitimately put an ES256 key first in an RS256 + ES256 set — so the
  // key is picked by alg from the set. Its public half is published at
  // /.well-known/jwks.json under the same kid. selectSigningKeyByAlg throws
  // when no RS256 key is registered, which surfaces as a server_error
  // (a configuration mistake) rather than as an unverifiable introspection
  // response.
  const introspectionSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  const introspectionSigningKey = selectSigningKeyByAlg(introspectionSigningKeys, 'RS256');
  const responseJwt = await createIntrospectionResponseJwt({
    issuer: c.get('config').issuer,
    audience: authenticatedClientId,
    introspection: restrictedResponse,
    signingKey: introspectionSigningKey,
  });
  // RFC 9701 §5: the success response is the compact JWS itself under its
  // own media type.
  return { status: 200, text: responseJwt, headers: { 'Content-Type': TOKEN_INTROSPECTION_JWT_MEDIA_TYPE } };
}`,
  call: `    const signed = await signIntrospectionResponse(c, introspection, authenticatedClientId);
    if (signed) return respondIntrospection(c, signed);`,
};

const RESPOND: StepFragment = {
  definition: `/**
 * Send an introspection answer. RFC 7662 Section 2.2: never cached.
 */
export function respondIntrospection(c: any, response: IntrospectionEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  if (response.text !== undefined) {
    return c.body(response.text, response.status);
  }
  return c.json(response.body ?? {}, response.status);
}`,
  call: `    return respondIntrospection(c, { status: 200, body: introspection });`,
};

const RESPOND_ERROR: StepFragment = {
  imports: { core: ['IntrospectionError', 'TokenError'] },
  definition: `/**
 * Answer a failure of any step with the OAuth error response.
 * RFC 7662 §2.3 / RFC 6749 §5.2
 */
export function respondIntrospectionError(c: any, error: unknown): Response {
  if (error instanceof IntrospectionEndpointError) {
    return respondIntrospection(c, error.response);
  }
  if (error instanceof TokenError || error instanceof IntrospectionError) {
    return respondIntrospection(c, {
      status: error.statusCode,
      body: { error: error.error, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondIntrospection(c, { status: 500, body: { error: 'server_error' } });
}`,
  call: '',
};

const FRAGMENTS: Record<string, StepFragment> = {
  'parse-request': PARSE_REQUEST,
  'authenticate-client': AUTHENTICATE_CLIENT,
  'resolve-token': RESOLVE_TOKEN,
  'build-response': BUILD_RESPONSE,
  'sign-response': SIGN_RESPONSE,
  respond: RESPOND,
  'respond-error': RESPOND_ERROR,
};

/** The generated `routes/introspection.ts`. `steps` is the `--flow` selection for the endpoint. */
export function introspectionRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  steps?: string[],
): string {
  const endpoint = buildOpFlow({ features }).endpoints.find((e) => e.id === 'introspection');
  if (endpoint === undefined) throw new Error('The flow catalog has no introspection endpoint');
  return renderPipelineRoute({
    endpoint,
    fragments: FRAGMENTS,
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true },
    header: HEADER,
    handlerOpen: `/**
 * Token Introspection Endpoint
 * RFC 7662 Section 2
 *
 * The pipeline: each statement below is one step function of this module, in
 * the order of the flow. A step that throws ends in respondIntrospectionError().
 */
introspectionApp.post('/', async (c) => {
  try {`,
    handlerClose: `  } catch (error) {
    return respondIntrospectionError(c, error);
  }
});
`,
  });
}
