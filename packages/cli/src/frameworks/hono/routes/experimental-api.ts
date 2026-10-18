/**
 * The experimental back-channel endpoints for the hono / express / fastify
 * output — `routes/par.ts`, `routes/register.ts`,
 * `routes/device-authorization.ts`, `routes/backchannel-authentication.ts` —
 * one fragment per step of their endpoints in the flow catalog.
 */
import { DEFAULT_FEATURES } from '../../../features.js';
import type { OidcFeatureConfig } from '../../../features.js';
import { buildOpFlow } from '../../../flow/catalog.js';
import type { FlowEndpoint } from '../../../flow/types.js';
import { EXPERIMENTAL_PACKAGE } from '../../packages.js';
import { renderPipelineRoute, type StepFragment } from '../pipeline.js';

const EXPERIMENTAL_NOTICE = ` * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.`;

function endpointOf(features: OidcFeatureConfig, scopes: string[], id: string): FlowEndpoint {
  const endpoint = buildOpFlow({ features, scopes }).endpoints.find((e) => e.id === id);
  if (endpoint === undefined) throw new Error(`The flow catalog has no ${id} endpoint`);
  return endpoint;
}

/** The response / error pair every back-channel endpoint of this module declares. */
function responseTypes(prefix: string, label: string, bodyType = 'object'): string {
  return `/** What the ${label} answers; respond${prefix}() turns it into HTTP. */
export interface ${prefix}EndpointResponse {
  status: number;
  body: ${bodyType};
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class ${prefix}EndpointError extends Error {
  constructor(readonly response: ${prefix}EndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? '${label} error'));
    this.name = '${prefix}EndpointError';
  }
}`;
}

/** RFC 6749 §3.1 parsing shared by the form-posted endpoints: no repeated parameter. */
function formParseBody(errorClass: string, mediaTypeDescription: string): string {
  return `  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    throw new ${errorClass}({
      status: 400,
      body: { error: 'invalid_request', error_description: '${mediaTypeDescription} must use application/x-www-form-urlencoded' },
    });
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    throw new ${errorClass}({
      status: 400,
      body: { error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` },
    });
  }

  const authorization = c.req.header('Authorization') ?? '';
  return { params, authorization };`;
}

const IS_FORM_URL_ENCODED = `function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}`;

/** The token-endpoint client authentication steps, as the back-channel endpoints repeat them. */
const CLIENT_AUTH_CORE_IMPORTS = [
  'extractClientCredentials',
  'resolveAuthenticatedTokenClient',
  'validateClientAuthMethod',
  'verifyClientSecret',
  'type TokenClientInfo',
];

// ---------------------------------------------------------------------------
// PAR
// ---------------------------------------------------------------------------

export function parRouteTemplate(corePkg: string, steps?: string[]): string {
  const fragments: Record<string, StepFragment> = {
    'parse-request': {
      imports: { core: ['sanitizeErrorDescription'] },
      definition: `/**
 * Parse the pushed authorization request: the form body and the Authorization
 * header. RFC 9126 §2.1 / RFC 6749 §3.1
 */
export async function parsePushedAuthorizationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
${formParseBody('ParEndpointError', 'Pushed authorization requests')}
}`,
      call: { bind: ['params', 'authorization'], expression: 'await parsePushedAuthorizationRequest(c)' },
    },
    'authenticate-client': {
      imports: {
        resolvers: ['clientResolver as defaultClientResolver'],
        modules: { [`${EXPERIMENTAL_PACKAGE}/par`]: ['authenticateParClient', 'rejectForbiddenParParams'] },
      },
      definition: `/**
 * Authenticate the pushing client exactly like the token endpoint does
 * (public clients present only client_id), after refusing the parameters a
 * pushed request must not carry. RFC 9126 §2.1
 *
 * client_id is a required authorization request parameter, so the pushed
 * parameters are pinned to the authenticated client before validation.
 */
export async function authenticatePushingClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<{ clientId: string; pushedParams: Record<string, string> }> {
  const clientResolver = c.get('clientResolver') ?? defaultClientResolver;

  // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
  // (PAR + JAR, §3) is not supported by this generated provider.
  rejectForbiddenParParams(params);

  const clientId = await authenticateParClient({
    params,
    authorizationHeader: authorization,
    clientResolver,
  });

  return { clientId, pushedParams: { ...params, client_id: clientId } };
}`,
      call: { bind: ['clientId', 'pushedParams'], expression: 'await authenticatePushingClient(c, params, authorization)' },
    },
    'validate-request': {
      imports: {
        resolvers: ['clientResolver as defaultClientResolver'],
        modules: { [`${EXPERIMENTAL_PACKAGE}/par`]: ['validatePushedAuthorizationParams'] },
      },
      definition: `/**
 * RFC 9126 §2.1: "validate the request the same way the authorization
 * endpoint would" — an unregistered redirect_uri or a bad scope fails here,
 * before the user ever sees a screen.
 */
export async function validatePushedRequest(c: any, pushedParams: Record<string, string>): Promise<void> {
  const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
  const config = c.get('config');
  await validatePushedAuthorizationParams(pushedParams, clientResolver, {
    allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
  });
}`,
      call: `    await validatePushedRequest(c, pushedParams);`,
    },
    'store-request': {
      imports: {
        store: ['parStore as defaultParStore'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/par`]: ['buildPushedAuthorizationResponse', 'createPushedAuthorizationRecord'],
        },
      },
      definition: `/**
 * RFC 9126 §2.2 / §7.1: mint a cryptographically random reference value and
 * store the request under it. Client credentials are never persisted.
 */
export async function storePushedRequest(
  c: any,
  clientId: string,
  pushedParams: Record<string, string>,
): Promise<ParEndpointResponse> {
  const parStore = c.get('parStore') ?? defaultParStore;
  const record = await createPushedAuthorizationRecord({
    clientId,
    params: pushedParams,
    store: parStore,
    expiresInSeconds: parConfig.expiresInSeconds,
  });
  const response = buildPushedAuthorizationResponse(record);

  // Never log the pushed parameters themselves: they can carry PII such as
  // login_hint, and the Authorization header carries the client_secret.

  // RFC 9126 §2.2: 201 Created.
  return { status: 201, body: { request_uri: response.requestUri, expires_in: response.expiresIn } };
}`,
      call: { bind: 'parResponse', expression: 'await storePushedRequest(c, clientId, pushedParams)' },
    },
    respond: {
      definition: `/** RFC 9126 §2.2: a non-cacheable JSON body. */
export function respondPar(c: any, response: ParEndpointResponse): Response {
  c.header('Cache-Control', 'no-cache, no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}`,
      call: `    return respondPar(c, parResponse);`,
    },
    'respond-error': {
      imports: { modules: { [`${EXPERIMENTAL_PACKAGE}/par`]: ['ParError'] } },
      definition: `/**
 * RFC 9126 §2.3: token-endpoint style JSON errors. This endpoint never redirects.
 */
export function respondParError(c: any, error: unknown): Response {
  if (error instanceof ParEndpointError) {
    return respondPar(c, error.response);
  }
  if (error instanceof ParError) {
    return respondPar(c, {
      status: error.statusCode,
      body: { error: error.code, error_description: error.errorDescription },
      headers: error.wwwAuthenticate ? { 'WWW-Authenticate': error.wwwAuthenticate } : undefined,
    });
  }
  return respondPar(c, { status: 500, body: { error: 'server_error' } });
}`,
      call: '',
    },
  };
  return renderPipelineRoute({
    endpoint: endpointOf({ ...DEFAULT_FEATURES, par: true }, [], 'par'),
    fragments,
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true, modules: { [`${EXPERIMENTAL_PACKAGE}/par`]: ['assertParExpiresInSeconds'] } },
    header: `/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126).
 *
 * This route was generated because the OP was created with \`--enable par\`.
${EXPERIMENTAL_NOTICE}
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived \`request_uri\` reference that it
 * then passes to /authorize. Every function exported below is one box of the
 * endpoint's pipeline (\`maronn-oidc graph --detail steps --endpoint par\`).
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */

/**
 * PAR settings. Imported by the authorize route, so keep both files in sync when
 * changing them.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through this endpoint, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
export const parConfig = {
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
};

assertParExpiresInSeconds(parConfig.expiresInSeconds);

${responseTypes('Par', 'pushed authorization request endpoint')}

export const parApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 9126 §2.1: the pushed authorization request body MUST be
 * application/x-www-form-urlencoded.
 */
${IS_FORM_URL_ENCODED}`,
    handlerOpen: `/**
 * Pushed Authorization Request Endpoint
 * RFC 9126 §2
 */
parApp.post('/', async (c) => {
  try {`,
    handlerClose: `  } catch (error) {
    return respondParError(c, error);
  }
});
`,
  });
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------------------

export function registerRouteTemplate(_corePkg: string, steps?: string[]): string {
  const fragments: Record<string, StepFragment> = {
    'verify-initial-access-token': {
      imports: { modules: { [`${EXPERIMENTAL_PACKAGE}/dynamic-client-registration`]: ['verifyInitialAccessToken'] } },
      definition: `/**
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
}`,
      call: `    await verifyRegistrationAccess(c);`,
    },
    'parse-request': {
      definition: `/**
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
}`,
      call: { bind: 'rawBody', expression: 'await parseRegistrationRequest(c)' },
    },
    'validate-metadata': {
      imports: {
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/dynamic-client-registration`]: [
            'buildRegisteredClient',
            'validateClientRegistrationRequest',
            'type DynamicallyRegisteredClient',
          ],
        },
      },
      definition: `/**
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
}`,
      call: { bind: 'client', expression: 'validateRegistrationMetadata(c, rawBody)' },
    },
    'store-client': {
      imports: {
        store: ['dynamicClientStore as defaultDynamicClientStore'],
        modules: { [`${EXPERIMENTAL_PACKAGE}/dynamic-client-registration`]: ['type DynamicallyRegisteredClient'] },
      },
      definition: `/**
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
}`,
      call: `    await storeRegisteredClient(c, client);`,
    },
    respond: {
      imports: {
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/dynamic-client-registration`]: [
            'buildClientRegistrationResponse',
            'type DynamicallyRegisteredClient',
          ],
        },
      },
      definition: `/**
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
}`,
      call: `    return respondRegistration(c, client);`,
    },
    'respond-error': {
      imports: { modules: { [`${EXPERIMENTAL_PACKAGE}/dynamic-client-registration`]: ['ClientRegistrationError'] } },
      definition: `/**
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
}`,
      call: '',
    },
  };
  return renderPipelineRoute({
    endpoint: endpointOf({ ...DEFAULT_FEATURES, dynamicClientRegistration: true }, [], 'register'),
    fragments,
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg: _corePkg,
    fixedImports: { hono: true },
    header: `/**
 * EXPERIMENTAL — Dynamic Client Registration (RFC 7591).
 *
 * This route was generated because the OP was created with
 * \`--enable dynamic-client-registration\`.
${EXPERIMENTAL_NOTICE}
 *
 * The client POSTs its metadata here as JSON and receives a freshly minted
 * client_id (and, for confidential clients, a client_secret) that works on
 * /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD); set initialAccessToken to require a Bearer token.
 * Every function exported below is one box of the endpoint's pipeline
 * (\`maronn-oidc graph --detail steps --endpoint register\`).
 */

/**
 * Dynamic client registration settings. apply.ts merges the applyOidc option
 * override over these defaults, so change them here or per deployment there.
 *
 * - initialAccessToken: when set, POST /register requires
 *   \`Authorization: Bearer <value>\` (OIDC Dynamic Client Registration 1.0 §3).
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

${responseTypes('Registration', 'client registration endpoint', 'object | null')}

export const registerApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 7591 §3.1: the registration request body MUST be application/json.
 */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}`,
    handlerOpen: `/**
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
  try {`,
    handlerClose: `  } catch (error) {
    return respondRegistrationError(c, error);
  }
});
`,
  });
}

// ---------------------------------------------------------------------------
// Device authorization endpoint
// ---------------------------------------------------------------------------

export function deviceAuthorizationRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
  steps?: string[],
): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeStep = customScopesDeclared
    ? `

  // RFC 6749 §3.3: reject a scope this OP never declared, the same way
  // /authorize does. Checked after applyOfflineAccessPolicy so an
  // offline_access that the policy already dropped stays ignored rather than
  // becoming invalid_scope (OIDC Core 1.0 §11).
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }`
    : '';
  const fragments: Record<string, StepFragment> = {
    'parse-request': {
      imports: { core: ['sanitizeErrorDescription'] },
      definition: `/**
 * Parse the device authorization request: the form body and the
 * Authorization header. RFC 8628 §3.1 / RFC 6749 §3.1
 */
export async function parseDeviceAuthorizationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
${formParseBody('DeviceAuthorizationEndpointError', 'Device authorization requests')}
}`,
      call: { bind: ['params', 'authorization'], expression: 'await parseDeviceAuthorizationRequest(c)' },
    },
    'authenticate-client': {
      imports: { core: CLIENT_AUTH_CORE_IMPORTS, resolvers: ['tokenClientResolver as defaultTokenClientResolver'] },
      definition: `/**
 * RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
 * [RFC6749] apply" — so this is the same pipeline the token endpoint runs,
 * step function for step function. Public clients present only client_id.
 */
export async function authenticateDeviceClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<TokenClientInfo> {
  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const client = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(client, presentedCredentials);
  await verifyClientSecret(client, presentedCredentials.clientSecret);
  return client;
}`,
      call: { bind: 'client', expression: 'await authenticateDeviceClient(c, params, authorization)' },
    },
    'validate-request': {
      imports: {
        core: ['findUnregisteredClientScopes', 'type TokenClientInfo'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/device-authorization-grant`]: [
            'DeviceAuthorizationError',
            'applyOfflineAccessPolicy',
            'validateDeviceAuthorizationScope',
            'validateDeviceGrantAllowed',
          ],
          ...(customScopesDeclared ? { '../scopes.js': ['findUnsupportedScopes'] } : {}),
        },
      },
      definition: `/**
 * Validate the grant registration and the requested scope, and apply the
 * offline_access policy. RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11
 *
 * Each check is an independent function from the experimental package or
 * core. Delete a call to drop that validation, or insert your own logic
 * between steps.
 */
export function validateDeviceAuthorizationRequest(
  params: Record<string, string>,
  client: TokenClientInfo,
): string[] {
  // RFC 6749 §5.2: the client must be registered for the device_code grant.
  validateDeviceGrantAllowed(client);

  // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
  // everywhere (same rule as /authorize). Requests that omit scope — legal per
  // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
  const requestedScope = validateDeviceAuthorizationScope(params['scope']);

  // RFC 7591 §2: a client registered with a scope list (client.scope) may only
  // request those scopes, the same rule as /authorize.
  const unregisteredScopes = findUnregisteredClientScopes(requestedScope, client.scope);
  if (unregisteredScopes.length > 0) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }

  // OIDC Core 1.0 §11: drop offline_access when it could never be granted.
  const scope = applyOfflineAccessPolicy(requestedScope, {
    client,
    refreshTokenFeatureEnabled: ${features.refreshToken ? 'true' : 'false'},
  });${customScopeStep}

  return scope;
}`,
      call: { bind: 'scope', expression: 'validateDeviceAuthorizationRequest(params, client)' },
    },
    'issue-device-code': {
      imports: {
        core: ['type TokenClientInfo'],
        store: ['deviceAuthorizationStore as defaultDeviceAuthorizationStore'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/device-authorization-grant`]: [
            'createDeviceAuthorizationRecord',
            'type DeviceAuthorizationRecord',
          ],
        },
      },
      definition: `/**
 * RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
 * base-20 user_code, then store the pending record under both.
 *
 * Never log device_code or user_code: both are live credentials for the
 * lifetime of the record (RFC 8628 §5.1 / §5.2).
 */
export async function issueDeviceCodes(
  c: any,
  client: TokenClientInfo,
  scope: string[],
): Promise<DeviceAuthorizationRecord> {
  const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;
  return createDeviceAuthorizationRecord({
    clientId: client.clientId,
    scope,
    store: deviceStore,
    expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
    interval: deviceAuthorizationConfig.pollInterval,
  });
}`,
      call: { bind: 'record', expression: 'await issueDeviceCodes(c, client, scope)' },
    },
    respond: {
      imports: {
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/device-authorization-grant`]: [
            'buildDeviceAuthorizationResponse',
            'type DeviceAuthorizationRecord',
          ],
        },
      },
      definition: `/**
 * RFC 8628 §3.2: the device authorization response. §3.2 has no explicit
 * caching rule, but device_code is a credential, so the response follows the
 * token response rules of RFC 6749 §5.1 (no-store).
 */
export function respondDeviceAuthorization(c: any, record: DeviceAuthorizationRecord): Response {
  const config = c.get('config');
  noStore(c);
  return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
}`,
      call: `    return respondDeviceAuthorization(c, record);`,
    },
    'respond-error': {
      imports: {
        core: ['TokenError'],
        modules: { [`${EXPERIMENTAL_PACKAGE}/device-authorization-grant`]: ['DeviceAuthorizationError'] },
      },
      definition: `/**
 * RFC 6749 §5.2 error shape. Authentication failures are core TokenErrors
 * (with their 401); everything the experimental package rejects is a
 * DeviceAuthorizationError.
 */
export function respondDeviceAuthorizationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof DeviceAuthorizationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof DeviceAuthorizationError) {
    return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
  }
  if (error instanceof TokenError) {
    if (error.wwwAuthenticate) {
      c.header('WWW-Authenticate', error.wwwAuthenticate);
    }
    return c.json({ error: error.error, error_description: error.errorDescription }, error.statusCode);
  }
  return c.json({ error: 'server_error' }, 500);
}`,
      call: '',
    },
  };
  return renderPipelineRoute({
    endpoint: endpointOf({ ...features, deviceAuthorizationGrant: true }, scopes, 'device-authorization'),
    fragments,
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true },
    header: `/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This route was generated because the OP was created with
 * \`--enable device-authorization-grant\`.
${EXPERIMENTAL_NOTICE}
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the end user types into /device on another
 * device's browser. Every function exported below is one box of the endpoint's
 * pipeline (\`maronn-oidc graph --detail steps --endpoint device-authorization\`).
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is deliberately
 * left to the deployment layer (reverse proxy / platform), not implemented here.
 * An in-process counter cannot work on runtimes without shared memory between
 * instances (Cloudflare Workers and friends), so putting one here would give a
 * false sense of protection. The in-band defenses are the 20^8 user_code
 * entropy, the short TTL, and answering every failed match identically.
 */

/**
 * EXPERIMENTAL — Device Authorization Grant settings (RFC 8628).
 *
 * Imported by the verification UI and the discovery route, so keep all three in
 * sync when changing them.
 *
 * - deviceCodeExpiresIn: §3.2 expires_in, in seconds. Keep it short: it is the
 *   window in which a user_code can be guessed (§5.1) or phished (§5.4).
 * - pollInterval: §3.2 interval, in seconds. The token endpoint raises a
 *   record's own interval by 5 every time it answers slow_down.
 * - maxLoginAttempts: failed device logins allowed per record before it is
 *   denied. Per-record only — see the security notes in the verification route.
 *
 * Not configurable: the user_code charset (RFC 8628 §6.1 base-20) and length (8).
 * They carry the entropy claim, so they are constants in the experimental
 * package rather than something a config typo can weaken.
 */
export const deviceAuthorizationConfig = {
  deviceCodeExpiresIn: 600,
  pollInterval: 5,
  maxLoginAttempts: 5,
};

${responseTypes('DeviceAuthorization', 'device authorization endpoint')}

export const deviceAuthorizationApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 8628 §3.1: the device authorization request body MUST be
 * application/x-www-form-urlencoded (it follows RFC 6749 §3.2.1).
 */
${IS_FORM_URL_ENCODED}

function noStore(c: any): void {
  // RFC 8628 §3.2 has no explicit rule, but device_code is a credential, so the
  // response follows the token response rules of RFC 6749 §5.1.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}`,
    handlerOpen: `/**
 * Device Authorization Endpoint
 * RFC 8628 §3.1 / §3.2
 */
deviceAuthorizationApp.post('/', async (c) => {
  try {`,
    handlerClose: `  } catch (error) {
    return respondDeviceAuthorizationError(c, error);
  }
});
`,
  });
}

// ---------------------------------------------------------------------------
// Backchannel authentication endpoint (CIBA)
// ---------------------------------------------------------------------------

export function backchannelAuthenticationRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
  steps?: string[],
): string {
  const customScopesDeclared = scopes.length > 0;
  const customScopeStep = customScopesDeclared
    ? `  // RFC 6749 §3.3: reject a scope this OP never declared, the same allow list
  // /authorize uses (scopes.ts). Checked before the pipeline so a request for
  // an unknown scope never reaches the store. offline_access is left out of
  // the check: the pipeline applies its own policy and ignores it when it
  // cannot be granted (OIDC Core 1.0 §11), which must not become an error.
  const unsupportedScopes = findUnsupportedScopes(
    (params['scope'] ?? '')
      .split(' ')
      .filter((scope) => scope.length > 0 && scope !== 'offline_access'),
  );
  if (unsupportedScopes.length > 0) {
    throw new BackchannelAuthenticationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

`
    : '';
  const fragments: Record<string, StepFragment> = {
    'parse-request': {
      imports: { core: ['sanitizeErrorDescription'] },
      definition: `/**
 * Parse the backchannel authentication request: the form body and the
 * Authorization header. CIBA Core 1.0 §7.1 / RFC 6749 §3.1
 */
export async function parseBackchannelAuthenticationRequest(
  c: any,
): Promise<{ params: Record<string, string>; authorization: string }> {
${formParseBody('BackchannelAuthenticationEndpointError', 'Backchannel authentication requests')}
}`,
      call: { bind: ['params', 'authorization'], expression: 'await parseBackchannelAuthenticationRequest(c)' },
    },
    'authenticate-client': {
      imports: { core: CLIENT_AUTH_CORE_IMPORTS, resolvers: ['tokenClientResolver as defaultTokenClientResolver'] },
      definition: `/**
 * CIBA §7.1: "The Client MUST authenticate ... using the authentication
 * method registered for its client_id" — the same pipeline the token
 * endpoint runs, step function for step function.
 */
export async function authenticateCibaClient(
  c: any,
  params: Record<string, string>,
  authorization: string,
): Promise<TokenClientInfo> {
  const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
  const presentedCredentials = extractClientCredentials({
    params,
    authorizationHeader: authorization,
  });
  const client = await resolveAuthenticatedTokenClient(
    presentedCredentials.clientId,
    tokenClientResolver,
  );
  validateClientAuthMethod(client, presentedCredentials);
  await verifyClientSecret(client, presentedCredentials.clientSecret);
  return client;
}`,
      call: { bind: 'client', expression: 'await authenticateCibaClient(c, params, authorization)' },
    },
    'validate-client-scope': {
      imports: {
        core: ['findUnregisteredClientScopes', 'type TokenClientInfo'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/ciba`]: ['BackchannelAuthenticationError'],
          ...(customScopesDeclared ? { '../scopes.js': ['findUnsupportedScopes'] } : {}),
        },
      },
      definition: `/**
 * RFC 7591 §2: a client registered with a scope list (client.scope) may only
 * request those scopes, the same rule as /authorize.
 */
export function validateCibaClientScope(params: Record<string, string>, client: TokenClientInfo): void {
${customScopeStep}  const unregisteredScopes = findUnregisteredClientScopes(
    (params['scope'] ?? '').split(' ').filter((scope) => scope.length > 0),
    client.scope,
  );
  if (unregisteredScopes.length > 0) {
    throw new BackchannelAuthenticationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }
}`,
      call: `    validateCibaClientScope(params, client);`,
    },
    'create-request': {
      imports: {
        core: ['type TokenClientInfo'],
        store: ['cibaAuthenticationRequestStore as defaultCibaAuthenticationRequestStore', 'userStore'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/ciba`]: ['processBackchannelAuthenticationRequest', 'type CibaClientInfo'],
        },
      },
      definition: `/**
 * Resolve the login_hint and create the pending authentication request.
 * CIBA Core 1.0 §7.1 - §7.3
 *
 * Validation runs in CIBA §7.1 order inside the experimental package:
 * client checks (public client / grant registration / delivery mode) →
 * request parameter rejection → the one-and-only-one hint rule → scope →
 * binding_message → requested_expiry → login_hint resolution → the
 * per-subject pending cap → record creation.
 *
 * login_hint → subject resolution is the deployment's swap point: the
 * default (wired in app.ts) treats the hint as a username of the configured
 * user store. Replace c.set('cibaUserResolver', ...) — or the fallback
 * below — to resolve email addresses, phone numbers, or your own ids.
 *
 * Never log auth_req_id (a live credential) or login_hint (PII, CIBA §15).
 */
export async function createBackchannelAuthenticationRequest(
  c: any,
  params: Record<string, string>,
  client: TokenClientInfo,
): Promise<object> {
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const resolveUser =
    c.get('cibaUserResolver') ??
    (async (loginHint: string) => {
      const claims = await userStore.getClaims(loginHint);
      return claims ? { subject: claims.sub } : null;
    });
  return processBackchannelAuthenticationRequest({
    params,
    client: client as CibaClientInfo,
    store: cibaStore,
    config: cibaConfig,
    refreshTokenFeatureEnabled: ${features.refreshToken ? 'true' : 'false'},
    resolveUser,
  });
}`,
      call: { bind: 'cibaResponse', expression: 'await createBackchannelAuthenticationRequest(c, params, client)' },
    },
    respond: {
      definition: `/**
 * CIBA Core 1.0 §7.3: the authentication request acknowledgement. auth_req_id
 * is a credential, so the response follows the token response rules of
 * RFC 6749 §5.1 (no-store).
 */
export function respondBackchannelAuthentication(c: any, response: object): Response {
  noStore(c);
  return c.json(response);
}`,
      call: `    return respondBackchannelAuthentication(c, cibaResponse);`,
    },
    'respond-error': {
      imports: { core: ['TokenError'], modules: { [`${EXPERIMENTAL_PACKAGE}/ciba`]: ['BackchannelAuthenticationError'] } },
      definition: `/**
 * CIBA §13 / RFC 6749 §5.2 error shape. Authentication failures are core
 * TokenErrors (with their 401); everything the experimental package rejects
 * is a BackchannelAuthenticationError.
 */
export function respondBackchannelAuthenticationError(c: any, error: unknown): Response {
  noStore(c);
  if (error instanceof BackchannelAuthenticationEndpointError) {
    for (const [name, value] of Object.entries(error.response.headers ?? {})) {
      c.header(name, value);
    }
    return c.json(error.response.body, error.response.status);
  }
  if (error instanceof BackchannelAuthenticationError) {
    return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
  }
  if (error instanceof TokenError) {
    if (error.wwwAuthenticate) {
      c.header('WWW-Authenticate', error.wwwAuthenticate);
    }
    return c.json({ error: error.error, error_description: error.errorDescription }, error.statusCode);
  }
  return c.json({ error: 'server_error' }, 500);
}`,
      call: '',
    },
  };
  return renderPipelineRoute({
    endpoint: endpointOf({ ...features, ciba: true }, scopes, 'backchannel-authentication'),
    fragments,
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: { hono: true },
    header: `/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), poll mode.
 *
 * This route was generated because the OP was created with \`--enable ciba\`.
${EXPERIMENTAL_NOTICE}
 *
 * The consumption device (a call-center console, a kiosk, a smart speaker
 * backend) POSTs here — back channel, client-authenticated — with a login_hint
 * naming the user, and receives an auth_req_id it polls the token endpoint
 * with. The user approves or denies on their own browser at /ciba. Every
 * function exported below is one box of the endpoint's pipeline
 * (\`maronn-oidc graph --detail steps --endpoint backchannel-authentication\`).
 *
 * NOTE (CIBA §15): the login_hint is a user identifier and therefore PII.
 * Never log it, and never echo it in an error_description. Rate limiting the
 * endpoint as a whole is deliberately left to the deployment layer (reverse
 * proxy / platform): an in-process counter cannot work on runtimes without
 * shared memory between instances. The in-band defenses are mandatory client
 * authentication, the fixed unknown_user_id wording, and the per-subject
 * pending-request cap below.
 */

/**
 * EXPERIMENTAL — CIBA settings (CIBA Core 1.0).
 *
 * Imported by the authentication device UI, the token route and the discovery
 * route, so keep all of them in sync when changing them.
 *
 * - authReqIdExpiresIn: §7.3 expires_in, in seconds (range 30–600). Keep it
 *   short: it is the window the user has to approve, and the window in which a
 *   pending request can pile up on the approval screen.
 * - pollingInterval: §7.3 interval, in seconds (range 1–60). The token endpoint
 *   raises a record's own interval by 5 every time it answers slow_down (§11).
 * - maxPendingPerSubject: pending backchannel requests allowed per user (range
 *   1–100) before new ones are refused — the flood defense for the approval
 *   screen (the role §7.1.2's unsupported user_code would otherwise play).
 * - maxLoginAttempts: failed /ciba logins allowed per login transaction before
 *   it is discarded. Per-transaction only — see the notes in the UI route.
 */
export const cibaConfig = {
  authReqIdExpiresIn: 120,
  pollingInterval: 5,
  maxPendingPerSubject: 10,
  maxLoginAttempts: 5,
};

// Fail fast on a config edit that leaves the documented ranges: a typo here
// weakens either the approval-screen flood cap or the polling contract.
if (cibaConfig.authReqIdExpiresIn < 30 || cibaConfig.authReqIdExpiresIn > 600) {
  throw new Error('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds');
}
if (cibaConfig.pollingInterval < 1 || cibaConfig.pollingInterval > 60) {
  throw new Error('cibaConfig.pollingInterval must be between 1 and 60 seconds');
}
if (cibaConfig.maxPendingPerSubject < 1 || cibaConfig.maxPendingPerSubject > 100) {
  throw new Error('cibaConfig.maxPendingPerSubject must be between 1 and 100');
}

${responseTypes('BackchannelAuthentication', 'backchannel authentication endpoint')}

export const backchannelAuthenticationApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * CIBA §7.1: the backchannel authentication request body MUST be
 * application/x-www-form-urlencoded.
 */
${IS_FORM_URL_ENCODED}

function noStore(c: any): void {
  // auth_req_id is a credential, so the response follows the token response
  // rules of RFC 6749 §5.1 / §5.2.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}`,
    handlerOpen: `/**
 * Backchannel Authentication Endpoint
 * CIBA Core 1.0 §7.1 / §7.2 / §7.3
 */
backchannelAuthenticationApp.post('/', async (c) => {
  try {`,
    handlerClose: `  } catch (error) {
    return respondBackchannelAuthenticationError(c, error);
  }
});
`,
  });
}
