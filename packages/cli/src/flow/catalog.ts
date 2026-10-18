/**
 * The catalog of everything `generate` can produce, as an OpFlow.
 *
 * Every endpoint of the generated OP is listed here with the steps of its
 * pipeline. The generators assemble the route modules from the same step
 * ids (see frameworks/hono/steps/), so the diagram `maronn-oidc graph` draws
 * and the generated functions are two views of one list.
 *
 * Wiring vocabulary used in `consumes` / `produces`: the names are the local
 * variables of the generated pipeline. The request context (`c`) is available
 * to every step and is not listed.
 */
import type { DbKind } from '../db.js';
import type { OidcFeatureConfig } from '../registry.js';
import type { FlowEdge, FlowEndpoint, FlowGroup, FlowStep, FlowStepKind, OpFlow } from './types.js';

export interface BuildOpFlowOptions {
  features: OidcFeatureConfig;
  /** Custom scopes declared with --scope (default: none). */
  scopes?: string[];
  /** --db kind (default: none, the in-memory stores). */
  db?: DbKind;
}

/** Defaults for the optional fields of a step so the catalog stays readable. */
type StepInput = Pick<FlowStep, 'id' | 'label' | 'kind' | 'function'> &
  Partial<Omit<FlowStep, 'id' | 'label' | 'kind' | 'function'>>;

function step(input: StepInput): FlowStep {
  return {
    calls: [],
    consumes: [],
    produces: [],
    removable: false,
    ...input,
  };
}

/** Sequential arrows through the given step ids, in order. */
function chain(ids: readonly string[], kind: FlowEdge['kind'] = 'flow'): FlowEdge[] {
  const edges: FlowEdge[] = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    edges.push({ from: ids[i] as string, to: ids[i + 1] as string, kind });
  }
  return edges;
}

/**
 * The dashed arrows into the error-responding step: every step that can fail
 * ends there. Steps that respond never fail into it.
 */
function errorEdges(steps: readonly FlowStep[], errorStepId: string): FlowEdge[] {
  return steps
    .filter((s) => s.kind !== 'respond' && s.id !== errorStepId)
    .map((s) => ({ from: s.id, to: errorStepId, kind: 'error' as const }));
}

function flowEdge(from: string, to: string, label?: string): FlowEdge {
  return label === undefined ? { from, to, kind: 'flow' } : { from, to, label, kind: 'flow' };
}

function branchEdge(from: string, to: string, label: string): FlowEdge {
  return { from, to, label, kind: 'branch' };
}

export const FLOW_GROUPS = {
  metadata: { id: 'metadata', label: 'Metadata' },
  authorizationCode: { id: 'authorization-code', label: 'Authorization Code Flow' },
  tokenManagement: { id: 'token-management', label: 'Token management' },
  pushedAuthorization: { id: 'pushed-authorization', label: 'Pushed Authorization Requests (RFC 9126)' },
  clientRegistration: { id: 'client-registration', label: 'Dynamic Client Registration (RFC 7591)' },
  deviceAuthorization: { id: 'device-authorization', label: 'Device Authorization Grant (RFC 8628)' },
  backchannelAuthentication: { id: 'backchannel-authentication', label: 'CIBA (poll mode)' },
  logout: { id: 'logout', label: 'RP-Initiated Logout 1.0' },
  googleLogin: { id: 'google-login', label: 'Sign in with Google (extension)' },
} as const satisfies Record<string, FlowGroup>;

type EndpointInput = Omit<FlowEndpoint, 'edges' | 'steps'> & {
  steps: FlowStep[];
  /** Arrows besides the error edges, which are added for `errorStep`. */
  edges: FlowEdge[];
  /** The step every failing step ends in; adds the dashed error arrows. */
  errorStep?: string;
};

function endpoint(input: EndpointInput): FlowEndpoint {
  const { errorStep, ...rest } = input;
  const edges = errorStep === undefined
    ? input.edges
    : [...input.edges, ...errorEdges(input.steps, errorStep)];
  return { ...rest, edges };
}

/** Keep the steps whose feature (if any) is enabled. */
function enabledSteps(steps: FlowStep[], features: OidcFeatureConfig): FlowStep[] {
  return steps.filter((s) => s.feature === undefined || features[s.feature]);
}

/** Keep the edges whose ends both exist. */
function edgesAmong(edges: FlowEdge[], ids: ReadonlySet<string>): FlowEdge[] {
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function discoveryEndpoint(features: OidcFeatureConfig): FlowEndpoint {
  const steps = [
    step({
      id: 'collect-signing-algorithms',
      label: 'Collect the advertised signing algorithms',
      kind: 'resolve',
      spec: 'OIDC Core 1.0 §15.1 / §5.3.2',
      function: 'collectAdvertisedSigningKeys',
      calls: ['getJwaAlgorithm'],
      produces: ['idTokenSigningKeys', 'userinfoSigningAlgValues'],
    }),
    step({
      id: 'build-metadata',
      label: 'Build the provider metadata',
      kind: 'transform',
      spec: 'OIDC Discovery 1.0 §3 / RFC 8414',
      function: 'buildDiscoveryMetadata',
      calls: ['buildProviderMetadata'],
      consumes: ['idTokenSigningKeys', 'userinfoSigningAlgValues'],
      produces: ['metadata'],
    }),
    step({
      id: 'respond',
      label: 'Respond with the cacheable JSON document',
      kind: 'respond',
      spec: 'RFC 8414 §3.2',
      function: 'respondDiscovery',
      consumes: ['metadata'],
    }),
  ];
  void features;
  return endpoint({
    id: 'discovery',
    label: 'Discovery',
    path: '/.well-known/openid-configuration',
    methods: ['GET'],
    layer: 'metadata',
    group: FLOW_GROUPS.metadata,
    spec: 'OIDC Discovery 1.0 §4',
    rearrangeable: true,
    steps,
    edges: chain(steps.map((s) => s.id)),
  });
}

function jwksEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'collect-public-keys',
      label: 'Collect every registered signing key',
      kind: 'resolve',
      function: 'collectPublishedKeys',
      produces: ['keys'],
    }),
    step({
      id: 'export-jwks',
      label: 'Export the public halves as a JWK Set',
      kind: 'transform',
      spec: 'RFC 7517 §5',
      function: 'buildJwksDocument',
      calls: ['extractAlgorithmParamsFromJwk', 'exportJwks'],
      consumes: ['keys'],
      produces: ['jwks'],
    }),
    step({
      id: 'respond',
      label: 'Respond with the cacheable JWK Set',
      kind: 'respond',
      function: 'respondJwks',
      consumes: ['jwks'],
    }),
  ];
  return endpoint({
    id: 'jwks',
    label: 'JWKS',
    path: '/.well-known/jwks.json',
    methods: ['GET'],
    layer: 'metadata',
    group: FLOW_GROUPS.metadata,
    spec: 'OIDC Discovery 1.0 §3 (jwks_uri)',
    rearrangeable: true,
    steps,
    edges: chain(steps.map((s) => s.id)),
  });
}

// ---------------------------------------------------------------------------
// Authorization Code Flow
// ---------------------------------------------------------------------------

function authorizeEndpoint(features: OidcFeatureConfig, customScopes: boolean): FlowEndpoint {
  // Without the request-object feature the parsed query IS the effective
  // request, so the later steps read params directly.
  const effective = features.requestObject ? 'effectiveParams' : 'params';
  const steps = enabledSteps(
    [
      step({
        id: 'parse-request',
        label: 'Parse the authorization request',
        kind: 'parse',
        spec: 'OIDC Core 1.0 §3.1.2.1 / §13.2',
        function: 'parseAuthorizationRequest',
        produces: ['params'],
      }),
      step({
        id: 'resolve-pushed-request',
        label: 'Expand the pushed request_uri',
        kind: 'resolve',
        spec: 'RFC 9126 §4 / §5',
        function: 'resolvePushedAuthorizationRequest',
        calls: ['assertPushedRequestUsed', 'resolvePushedRequestUri'],
        consumes: ['params'],
        produces: ['params'],
        feature: 'par',
      }),
      step({
        id: 'resolve-client',
        label: 'Resolve the client',
        kind: 'resolve',
        spec: 'OAuth 2.1 §4.1.2.1 / RFC 8252 §8',
        function: 'resolveAuthorizationClient',
        calls: ['resolveClientForAuthorization', 'validateRegisteredRedirectUris'],
        consumes: ['params'],
        produces: ['client'],
      }),
      step({
        id: 'resolve-request-object',
        label: 'Verify the Request Object and overlay its claims',
        kind: 'resolve',
        spec: 'OIDC Core 1.0 §6.1',
        function: 'resolveRequestObject',
        calls: ['resolveRequestObjectParams'],
        consumes: ['params', 'client'],
        produces: ['effectiveParams', 'requestObjectClaims'],
        feature: 'requestObject',
      }),
      step({
        id: 'resolve-redirect-uri',
        label: 'Resolve redirect_uri (errors become redirectable)',
        kind: 'resolve',
        spec: 'OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1',
        function: 'resolveRedirectTarget',
        calls: ['resolveAuthorizationRedirectUri'],
        consumes: [effective, 'client'],
        produces: ['redirectUri', 'state'],
      }),
      step({
        id: 'resolve-jarm-response-mode',
        label: 'Interpret response_mode=query.jwt',
        kind: 'resolve',
        spec: 'JARM §2.3 / §3',
        function: 'resolveJarmResponseContext',
        calls: ['resolveJarmResponseMode', 'selectSigningKeyByAlg'],
        consumes: [effective, 'client', 'redirectUri', 'state', 'issuer'],
        produces: ['jarmResponse'],
        feature: 'jarm',
      }),
      step({
        id: 'validate-request',
        label: 'Validate the request parameters',
        kind: 'validate',
        spec: 'OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5',
        function: 'validateAuthorizationRequestParams',
        calls: [
          'rejectUnsupportedRequestParams',
          ...(features.requestObject ? ['validateRequestObjectConsistency'] : []),
          'validateResponseType',
          'validateAuthorizationScope',
          'validateClientScope',
          'validateAuthorizationCodePkce',
          'validatePromptParameter',
          'applyOfflineAccessPolicy',
          ...(customScopes ? ['findUnsupportedScopes'] : []),
          'validateDisplayParameter',
          'resolveMaxAge',
          'parseAudienceParameter',
          'parseClaimsRequestParameter',
          'validateAcrValuesParameter',
        ],
        consumes: [
          'params',
          ...(features.requestObject ? ['effectiveParams', 'requestObjectClaims'] : []),
          'client',
          'redirectUri',
          'state',
        ],
        produces: ['validatedRequest'],
      }),
      step({
        id: 'create-transaction',
        label: 'Create and store the authorization transaction',
        kind: 'persist',
        spec: 'OIDC Core 1.0 §3.1.2.3',
        function: 'createAuthorizationTransaction',
        calls: ['generateRandomString', 'createAuthTransaction'],
        consumes: ['validatedRequest', ...(features.jarm ? ['jarmResponse'] : [])],
        produces: ['transactionId', 'transaction', 'transactionTtlSeconds'],
      }),
      step({
        id: 'validate-prompt-combination',
        label: 'Reject prompt=none combined with other values',
        kind: 'validate',
        spec: 'OIDC Core 1.0 §3.1.2.1',
        function: 'rejectCombinedPromptNone',
        consumes: ['transactionId', 'transaction', 'issuer', ...(features.jarm ? ['jarmResponse'] : [])],
        produces: ['promptValues'],
      }),
      step({
        id: 'verify-id-token-hint',
        label: 'Verify id_token_hint',
        kind: 'validate',
        spec: 'OIDC Core 1.0 §3.1.2.1',
        function: 'verifyIdTokenHint',
        calls: ['validateIdTokenHint'],
        consumes: ['transactionId', 'transaction', 'issuer', ...(features.jarm ? ['jarmResponse'] : [])],
        produces: ['verifiedHintSubject'],
        removable: true,
        fallback: true,
      }),
      step({
        id: 'authenticate-silently',
        label: 'prompt=none: authenticate without interaction',
        kind: 'dispatch',
        spec: 'OIDC Core 1.0 §3.1.2.1',
        function: 'completePromptNoneRequest',
        calls: [
          'resolvePromptNoneSession',
          'validatePromptNoneIdTokenHint',
          ...(customScopes ? ['resolveGrantableScopes'] : []),
          'validatePromptNoneConsent',
          'requiresReauthentication',
        ],
        consumes: [
          'promptValues',
          'transactionId',
          'transaction',
          'verifiedHintSubject',
          'issuer',
          ...(features.jarm ? ['jarmResponse'] : []),
        ],
        produces: ['session'],
        removable: true,
      }),
      step({
        id: 'reuse-session',
        label: 'Single Sign-On: reuse the active OP session',
        kind: 'dispatch',
        spec: 'OIDC Core 1.0 §3.1.2.3',
        function: 'reuseExistingSession',
        calls: [
          'requiresReauthentication',
          ...(customScopes ? ['resolveGrantableScopes'] : []),
          'consentResolver.hasConsent',
        ],
        consumes: ['promptValues', 'transactionId', 'transaction', 'transactionTtlSeconds', 'verifiedHintSubject'],
        produces: ['session'],
        removable: true,
      }),
      step({
        id: 'issue-authorization-code',
        label: 'Issue the authorization code and build the response URL',
        kind: 'issue',
        spec: 'OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2',
        function: 'issueAuthorizationCodeResponse',
        calls: ['completeAuthTransaction', 'createAuthorizationCode', 'consentResolver.recordGrant'],
        consumes: ['transactionId', 'transaction', 'session', 'issuer', ...(features.jarm ? ['jarmResponse'] : [])],
        calledFrom: ['authenticate-silently', 'reuse-session'],
      }),
      step({
        id: 'continue-to-login',
        label: 'Continue on the login screen',
        kind: 'respond',
        spec: 'OIDC Core 1.0 §3.1.2.3',
        function: 'continueToLogin',
        calls: ['buildTransactionCookie'],
        consumes: ['transactionId', 'transactionTtlSeconds'],
      }),
      step({
        id: 'respond-error',
        label: 'Map a failure to a redirectable or on-OP error',
        kind: 'respond',
        spec: 'OIDC Core 1.0 §3.1.2.6 / §3.1.2.2',
        function: 'authorizationErrorOutcome',
        consumes: [...(features.jarm ? ['jarmResponse'] : [])],
      }),
    ],
    features,
  );
  const ids = new Set(steps.map((s) => s.id));
  const sequence = steps
    .filter((s) => s.calledFrom === undefined && s.id !== 'respond-error')
    .map((s) => s.id);
  const edges = [
    ...chain(sequence),
    ...edgesAmong(
      [
        branchEdge('authenticate-silently', 'issue-authorization-code', 'session + consent'),
        branchEdge('reuse-session', 'issue-authorization-code', 'session + prior consent'),
        branchEdge('reuse-session', 'continue-to-login', 'consent screen'),
      ],
      ids,
    ),
  ];
  return endpoint({
    id: 'authorize',
    label: 'Authorization endpoint',
    path: '/authorize',
    methods: ['GET', 'POST'],
    layer: 'browser',
    group: FLOW_GROUPS.authorizationCode,
    spec: 'OIDC Core 1.0 §3.1.2',
    rearrangeable: true,
    initial: ['issuer'],
    steps,
    edges,
    errorStep: 'respond-error',
  });
}

function loginEndpoint(features: OidcFeatureConfig): FlowEndpoint {
  const steps = enabledSteps(
    [
      step({
        id: 'load-transaction',
        label: 'Load the transaction named by the cookie',
        kind: 'resolve',
        spec: 'OIDC Core 1.0 §3.1.2.3',
        function: 'loadTransaction',
        calls: ['parseTransactionId', 'getAuthTransaction'],
        produces: ['transactionId', 'transaction'],
      }),
      step({
        id: 'describe-login-screen',
        label: 'Describe the login form',
        kind: 'transform',
        spec: 'OIDC Core 1.0 §3.1.2.1 (login_hint)',
        function: 'describeLoginScreen',
        calls: features.googleLogin ? ['buildGoogleSignIn'] : [],
        consumes: features.googleLogin ? ['transactionId', 'transaction'] : ['transaction'],
        produces: ['screen'],
      }),
      step({
        id: 'reject-cross-origin-post',
        label: 'Reject a form POST from another origin',
        kind: 'validate',
        function: 'rejectCrossOriginFormPost',
        calls: ['isSameOriginFormPost'],
      }),
      step({
        id: 'validate-csrf-token',
        label: 'Check csrf_token against the transaction',
        kind: 'validate',
        function: 'validateLoginCsrfToken',
        calls: ['validateCsrfToken'],
        consumes: ['transaction', 'csrfToken'],
      }),
      step({
        id: 'authenticate-user',
        label: 'Check the credentials',
        kind: 'validate',
        function: 'authenticateEndUser',
        calls: ['userStore.authenticate'],
        consumes: ['username', 'password'],
        produces: ['user'],
      }),
      step({
        id: 'record-login-failure',
        label: 'Count the failed attempt (lockout)',
        kind: 'persist',
        function: 'recordLoginFailure',
        calls: ['handleLoginFailure'],
        consumes: ['transactionId', 'transaction'],
      }),
      step({
        id: 'discard-session-for-fresh-login',
        label: 'prompt=login: discard the existing session',
        kind: 'persist',
        spec: 'OIDC Core 1.0 §3.1.2.1',
        function: 'discardSessionForFreshLogin',
        consumes: ['transactionId', 'transaction'],
      }),
      step({
        id: 'establish-session',
        label: 'Establish the OP browser session',
        kind: 'persist',
        spec: 'OIDC Core 1.0 §3.1.2.3',
        function: 'establishBrowserSession',
        calls: ['generateRandomString'],
        consumes: ['user'],
        produces: ['sessionId', 'authTime'],
      }),
      step({
        id: 'hand-off-to-consent',
        label: 'Store the authenticated subject for the consent step',
        kind: 'persist',
        function: 'handOffToConsent',
        calls: ['buildSessionCookie'],
        consumes: ['transactionId', 'user', 'sessionId', 'authTime'],
        produces: ['outcome'],
      }),
    ],
    features,
  );
  return endpoint({
    id: 'login',
    label: 'Login screen',
    path: '/login',
    methods: ['GET', 'POST'],
    layer: 'browser',
    group: FLOW_GROUPS.authorizationCode,
    spec: 'OIDC Core 1.0 §3.1.2.3',
    rearrangeable: false,
    steps,
    edges: [
      flowEdge('load-transaction', 'describe-login-screen', 'GET'),
      flowEdge('reject-cross-origin-post', 'load-transaction', 'POST'),
      flowEdge('load-transaction', 'validate-csrf-token', 'POST'),
      flowEdge('validate-csrf-token', 'authenticate-user'),
      branchEdge('authenticate-user', 'record-login-failure', 'wrong credentials'),
      branchEdge('record-login-failure', 'describe-login-screen', 'retry'),
      branchEdge('authenticate-user', 'discard-session-for-fresh-login', 'authenticated'),
      flowEdge('discard-session-for-fresh-login', 'establish-session'),
      flowEdge('establish-session', 'hand-off-to-consent'),
    ],
  });
}

function googleLoginEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'verify-google-callback',
      label: 'Verify the posted Google ID token and nonce',
      kind: 'validate',
      function: 'verifyGoogleLoginCallback',
      calls: ['handleGoogleLoginRedirect', 'resolveGoogleLoginSubject'],
      produces: ['transactionId', 'subject'],
    }),
    step({
      id: 'load-transaction',
      label: 'Load the transaction the nonce was issued for',
      kind: 'resolve',
      function: 'loadTransactionById',
      calls: ['getAuthTransaction'],
      consumes: ['transactionId'],
      produces: ['transaction'],
    }),
    step({
      id: 'discard-session-for-fresh-login',
      label: 'prompt=login: discard the existing session',
      kind: 'persist',
      spec: 'OIDC Core 1.0 §3.1.2.1',
      function: 'discardSessionForFreshLogin',
      consumes: ['transactionId', 'transaction'],
    }),
    step({
      id: 'establish-session',
      label: 'Establish the OP browser session',
      kind: 'persist',
      spec: 'OIDC Core 1.0 §3.1.2.3',
      function: 'establishBrowserSession',
      calls: ['generateRandomString'],
      consumes: ['subject'],
      produces: ['sessionId', 'authTime'],
    }),
    step({
      id: 'hand-off-to-consent',
      label: 'Store the authenticated subject for the consent step',
      kind: 'persist',
      function: 'handOffToConsent',
      calls: ['buildSessionCookie'],
      consumes: ['transactionId', 'subject', 'sessionId', 'authTime'],
      produces: ['outcome'],
    }),
  ];
  return endpoint({
    id: 'login-google',
    label: 'Google login callback (login_uri)',
    path: '/login/google',
    methods: ['POST'],
    layer: 'browser',
    group: FLOW_GROUPS.googleLogin,
    feature: 'googleLogin',
    rearrangeable: false,
    steps,
    edges: chain(steps.map((s) => s.id)),
  });
}

function consentEndpoint(features: OidcFeatureConfig, customScopes: boolean): FlowEndpoint {
  const steps = [
    step({
      id: 'load-transaction',
      label: 'Load the transaction named by the cookie',
      kind: 'resolve',
      spec: 'OIDC Core 1.0 §3.1.2.4',
      function: 'loadTransaction',
      calls: ['parseTransactionId', 'getAuthTransaction'],
      produces: ['transactionId', 'transaction'],
    }),
    step({
      id: 'describe-consent-screen',
      label: 'Describe the consent form',
      kind: 'transform',
      function: 'describeConsentScreen',
      calls: customScopes ? ['resolveGrantableScopes'] : [],
      consumes: customScopes ? ['transactionId', 'transaction'] : ['transaction'],
      produces: ['screen'],
    }),
    step({
      id: 'reject-cross-origin-post',
      label: 'Reject a form POST from another origin',
      kind: 'validate',
      function: 'rejectCrossOriginFormPost',
      calls: ['isSameOriginFormPost'],
    }),
    step({
      id: 'validate-csrf-token',
      label: 'Check csrf_token against the transaction',
      kind: 'validate',
      function: 'validateConsentCsrfToken',
      calls: ['validateCsrfToken'],
      consumes: ['transaction', 'csrfToken'],
    }),
    step({
      id: 'deny-authorization',
      label: 'Deny: answer access_denied',
      kind: 'respond',
      spec: 'OIDC Core 1.0 §3.1.2.6',
      function: 'denyAuthorizationRequest',
      calls: ['buildConsentRedirect'],
      consumes: ['transactionId', 'transaction', 'issuer'],
      produces: ['outcome'],
    }),
    step({
      id: 'validate-decision',
      label: 'Require an explicit approve decision',
      kind: 'validate',
      spec: 'OIDC Core 1.0 §3.1.2.4',
      function: 'validateConsentDecision',
      consumes: ['action'],
    }),
    step({
      id: 'require-authenticated-subject',
      label: 'Require the subject the login step stored',
      kind: 'resolve',
      function: 'requireAuthenticatedSubject',
      consumes: ['transactionId'],
      produces: ['session'],
    }),
    step({
      id: 'issue-authorization-code',
      label: 'Issue the authorization code',
      kind: 'issue',
      spec: 'OIDC Core 1.0 §3.1.2.5 / §3.1.3.1',
      function: 'issueConsentedAuthorizationCode',
      calls: [
        'completeAuthTransaction',
        ...(customScopes ? ['resolveGrantableScopes'] : []),
        'createAuthorizationCode',
      ],
      consumes: ['transactionId', 'transaction', 'session'],
      produces: ['responseParams', 'authCodeData', 'grantedScope'],
    }),
    step({
      id: 'record-consent',
      label: 'Record the consent and the grant',
      kind: 'persist',
      spec: 'OIDC Core 1.0 §3.1.2.4',
      function: 'recordConsentDecision',
      calls: ['consentResolver.recordConsent', 'consentResolver.recordGrant'],
      consumes: ['transactionId', 'transaction', 'session', 'authCodeData', 'grantedScope'],
    }),
    step({
      id: 'build-authorization-response',
      label: 'Build the authorization response URL',
      kind: 'transform',
      spec: features.jarm ? 'RFC 9207 §2 / JARM §2.3.1' : 'RFC 9207 §2',
      function: 'buildConsentRedirect',
      calls: features.jarm ? ['buildJarmRedirectUrl', 'createJarmResponseJwt'] : [],
      consumes: [...(features.jarm ? ['transaction'] : []), 'responseParams', 'authCodeData', 'issuer'],
      produces: ['outcome'],
    }),
  ];
  return endpoint({
    id: 'consent',
    label: 'Consent screen',
    path: '/consent',
    methods: ['GET', 'POST'],
    layer: 'browser',
    group: FLOW_GROUPS.authorizationCode,
    spec: 'OIDC Core 1.0 §3.1.2.4',
    rearrangeable: false,
    steps,
    edges: [
      flowEdge('load-transaction', 'describe-consent-screen', 'GET'),
      flowEdge('reject-cross-origin-post', 'load-transaction', 'POST'),
      flowEdge('load-transaction', 'validate-csrf-token', 'POST'),
      branchEdge('validate-csrf-token', 'deny-authorization', 'action=deny'),
      branchEdge('validate-csrf-token', 'validate-decision', 'action=approve'),
      flowEdge('validate-decision', 'require-authenticated-subject'),
      flowEdge('require-authenticated-subject', 'issue-authorization-code'),
      flowEdge('issue-authorization-code', 'record-consent'),
      flowEdge('record-consent', 'build-authorization-response'),
    ],
  });
}

function tokenEndpoint(features: OidcFeatureConfig): FlowEndpoint {
  const steps = enabledSteps(
    [
      step({
        id: 'parse-request',
        label: 'Parse the token request',
        kind: 'parse',
        spec: 'RFC 6749 §4.1.3 / §3.2',
        function: 'parseTokenRequest',
        produces: ['params', 'authorization'],
      }),
      step({
        id: 'authenticate-client',
        label: 'Authenticate the client',
        kind: 'validate',
        spec: 'OAuth 2.1 §2.3 / OIDC Core 1.0 §9',
        function: 'authenticateTokenClient',
        calls: [
          'extractClientCredentials',
          'resolveAuthenticatedTokenClient',
          'validateClientAuthMethod',
          'verifyClientSecret',
        ],
        consumes: ['params', 'authorization'],
        produces: ['tokenClient', 'authenticatedClientId'],
      }),
      step({
        id: 'dispatch-id-jag-issuance',
        label: 'Issue an ID-JAG (Cross-App Access)',
        kind: 'dispatch',
        spec: 'ID-JAG draft §4.3',
        function: 'issueIdJag',
        calls: ['matchesIdJagIssuanceRequest', 'selectSigningKeyByAlg', 'processIdJagIssuanceRequest'],
        consumes: ['params', 'tokenClient'],
        feature: 'idJag',
        before: ['dispatch-token-exchange', 'validate-grant-type'],
      }),
      step({
        id: 'dispatch-id-jag-redemption',
        label: 'Redeem an ID-JAG on the jwt-bearer grant',
        kind: 'dispatch',
        spec: 'ID-JAG draft §4.4 / RFC 7523 §2.1',
        function: 'redeemIdJag',
        calls: ['processIdJagRedemptionRequest', 'buildAccessTokenAudience', 'buildAccessTokenPayload'],
        consumes: ['params', 'tokenClient'],
        feature: 'idJag',
        before: ['validate-grant-type'],
      }),
      step({
        id: 'dispatch-token-exchange',
        label: 'Token Exchange',
        kind: 'dispatch',
        spec: 'RFC 8693 §2.1',
        function: 'exchangeToken',
        calls: [
          'processTokenExchangeRequest',
          'buildAccessTokenAudience',
          'buildAccessTokenPayload',
          'buildTokenExchangeResponse',
        ],
        consumes: ['params', 'tokenClient'],
        feature: 'tokenExchange',
        before: ['validate-grant-type'],
      }),
      step({
        id: 'dispatch-device-code',
        label: 'Redeem a device_code',
        kind: 'dispatch',
        spec: 'RFC 8628 §3.4 / §3.5',
        function: 'redeemDeviceCode',
        calls: [
          'processDeviceCodeGrant',
          'selectSigningKeyByAlg',
          'buildAccessTokenAudience',
          'buildAccessTokenPayload',
          'computeAtHash',
          'resolveAcrAmr',
          'buildIdTokenPayload',
          'generateIdToken',
        ],
        consumes: ['params', 'tokenClient', 'authenticatedClientId'],
        feature: 'deviceAuthorizationGrant',
        before: ['validate-grant-type'],
      }),
      step({
        id: 'dispatch-ciba',
        label: 'Redeem an auth_req_id (CIBA)',
        kind: 'dispatch',
        spec: 'CIBA Core 1.0 §10.1 / §11',
        function: 'redeemCibaRequest',
        calls: [
          'processCibaGrant',
          'selectSigningKeyByAlg',
          'buildAccessTokenAudience',
          'buildAccessTokenPayload',
          'computeAtHash',
          'resolveAcrAmr',
          'buildIdTokenPayload',
          'generateIdToken',
        ],
        consumes: ['params', 'tokenClient', 'authenticatedClientId'],
        feature: 'ciba',
        before: ['validate-grant-type'],
      }),
      step({
        id: 'validate-grant-type',
        label: 'Validate grant_type',
        kind: 'validate',
        spec: 'RFC 6749 §5.2',
        function: 'validateTokenGrantType',
        calls: ['validateGrantTypeSupported', 'validateClientGrantType'],
        consumes: ['params', 'tokenClient'],
        produces: ['grantType'],
      }),
      step({
        id: 'validate-authorization-code-grant',
        label: 'Validate the authorization_code grant',
        kind: 'validate',
        spec: 'OAuth 2.1 §4.1.2 / RFC 7636 / OIDC Core 1.0 §3.1.3.2',
        function: 'validateAuthorizationCodeGrant',
        calls: [
          'resolveAuthorizationCode',
          'validateAuthorizationCodeUnused',
          'validateAuthorizationCodeClient',
          'validateAuthorizationCodeExpiration',
          'validateAuthorizationCodeRedirectUri',
          'verifyAuthorizationCodePkce',
          'consumeAuthorizationCode',
          'buildValidatedAuthorizationCodeRequest',
        ],
        // Without the refresh_token grant there is no branch to pick, so the
        // grant_type result is only checked, not read.
        consumes: ['params', 'authenticatedClientId', ...(features.refreshToken ? ['grantType'] : [])],
        produces: ['validatedRequest'],
      }),
      step({
        id: 'validate-refresh-token-grant',
        label: 'Validate the refresh_token grant',
        kind: 'validate',
        spec: 'OAuth 2.1 §4.3.1 / RFC 6749 §6',
        function: 'validateRefreshTokenGrant',
        calls: [
          'resolveRefreshToken',
          'validateRefreshTokenUnused',
          'validateRefreshTokenClient',
          'validateRefreshTokenExpiration',
          'validateRefreshTokenIdleTimeout',
          'validateRefreshTokenSession',
          'validateRefreshTokenScope',
          'buildValidatedRefreshTokenRequest',
        ],
        consumes: ['params', 'authenticatedClientId', 'grantType'],
        produces: ['validatedRequest'],
        feature: 'refreshToken',
      }),
      step({
        id: 'select-signing-keys',
        label: 'Select the signing keys',
        kind: 'resolve',
        spec: 'OIDC Dynamic Client Registration 1.0 §2 (id_token_signed_response_alg)',
        function: 'selectTokenSigningKeys',
        calls: ['selectSigningKeyByAlg'],
        consumes: ['authenticatedClientId'],
        produces: ['signingKey', 'idTokenSigningKey'],
      }),
      step({
        id: 'resolve-subject',
        label: 'Resolve the subject, auth_time and nonce',
        kind: 'resolve',
        spec: 'OIDC Core 1.0 §12.2',
        function: 'resolveTokenSubject',
        consumes: ['validatedRequest'],
        produces: ['subject', 'authTime', 'nonce'],
      }),
      step({
        id: 'decide-refresh-token-issuance',
        label: 'Decide whether a refresh token is issued',
        kind: 'decide',
        spec: 'OIDC Core 1.0 §11 / RFC 9700 §4.14',
        function: 'decideRefreshTokenIssuance',
        calls: ['clientAllowsRefreshTokenGrant'],
        consumes: ['tokenClient', 'validatedRequest'],
        produces: ['refreshTokenDecision'],
        feature: 'refreshToken',
      }),
      step({
        id: 'resolve-acr-amr',
        label: 'Resolve the acr / amr the tokens carry',
        kind: 'resolve',
        spec: 'OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1',
        function: 'resolveTokenAcrAmr',
        calls: ['selectRequestedAcrValues', 'resolveAcrAmr', 'selectPreferredAcr'],
        consumes: ['subject', 'validatedRequest'],
        produces: ['acr', 'amr'],
        removable: true,
        fallback: true,
      }),
      step({
        id: 'issue-access-token',
        label: 'Issue the access token',
        kind: 'issue',
        spec: 'RFC 9068 §2.2 / §2.2.1 / §3',
        function: 'issueAccessToken',
        calls: [
          'buildAccessTokenAudience',
          'buildAccessTokenPayload',
          'createJwtAccessTokenIssuer',
          'createOpaqueAccessTokenIssuer',
        ],
        consumes: ['signingKey', 'subject', 'validatedRequest', 'acr'],
        produces: ['issuedAt', 'accessToken', 'accessTokenPayload', 'audience'],
      }),
      step({
        id: 'issue-id-token',
        label: 'Issue the ID Token',
        kind: 'issue',
        spec: 'OIDC Core 1.0 §3.1.3.6 / §12.1',
        function: 'issueIdToken',
        calls: ['computeAtHash', 'buildIdTokenPayload', 'generateIdToken'],
        consumes: [
          'idTokenSigningKey',
          'accessToken',
          'subject',
          'authTime',
          'nonce',
          'validatedRequest',
          'issuedAt',
          'acr',
          'amr',
        ],
        produces: ['idToken'],
        removable: true,
        fallback: true,
      }),
      step({
        id: 'persist-access-token',
        label: 'Store the access token record',
        kind: 'persist',
        spec: 'RFC 7662 §2.2 / OIDC Core 1.0 §5.5 / RFC 9470 §6.2',
        function: 'persistAccessToken',
        consumes: ['accessToken', 'accessTokenPayload', 'subject', 'validatedRequest', 'issuedAt', 'audience', 'acr'],
      }),
      step({
        id: 'issue-refresh-token',
        label: 'Mint and store the refresh token',
        kind: 'issue',
        spec: 'OAuth 2.1 §4.3.1 / §6.1',
        function: 'issueRefreshToken',
        calls: ['generateRandomString'],
        consumes: [
          'refreshTokenDecision',
          'subject',
          'authTime',
          'nonce',
          'validatedRequest',
          'issuedAt',
          'audience',
          'acr',
          'amr',
        ],
        produces: ['refreshToken'],
        feature: 'refreshToken',
      }),
      step({
        id: 'revoke-rotated-refresh-token',
        label: 'Revoke the presented refresh token (rotation)',
        kind: 'persist',
        spec: 'OAuth 2.1 §4.3.1',
        function: 'revokeRotatedRefreshToken',
        consumes: ['params', 'validatedRequest'],
        feature: 'refreshToken',
        removable: true,
        after: ['issue-refresh-token'],
      }),
      step({
        id: 'build-token-response',
        label: 'Build the token response body',
        kind: 'transform',
        spec: 'OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1',
        function: 'buildTokenResponse',
        consumes: ['accessToken', 'idToken', ...(features.refreshToken ? ['refreshToken'] : []), 'validatedRequest'],
        produces: ['tokenResponse'],
      }),
      step({
        id: 'respond',
        label: 'Respond (no-store)',
        kind: 'respond',
        spec: 'RFC 6749 §5.1',
        function: 'respondToken',
        consumes: ['tokenResponse'],
      }),
      step({
        id: 'respond-error',
        label: 'Respond with the OAuth error',
        kind: 'respond',
        spec: 'RFC 6749 §5.2 / RFC 6750 §3',
        function: 'respondTokenError',
      }),
    ],
    features,
  );
  const ids = new Set(steps.map((s) => s.id));
  const linear = steps
    .filter(
      (s) =>
        s.id !== 'respond-error' &&
        s.id !== 'validate-authorization-code-grant' &&
        s.id !== 'validate-refresh-token-grant',
    )
    .map((s) => s.id);
  // The grant branch sits between validate-grant-type and select-signing-keys.
  const edges: FlowEdge[] = [];
  for (let i = 0; i + 1 < linear.length; i++) {
    const from = linear[i] as string;
    const to = linear[i + 1] as string;
    if (from === 'validate-grant-type') {
      edges.push(branchEdge(from, 'validate-authorization-code-grant', 'authorization_code'));
      edges.push(flowEdge('validate-authorization-code-grant', to));
      if (ids.has('validate-refresh-token-grant')) {
        edges.push(branchEdge(from, 'validate-refresh-token-grant', 'refresh_token'));
        edges.push(flowEdge('validate-refresh-token-grant', to));
      }
      continue;
    }
    edges.push(flowEdge(from, to));
  }
  for (const s of steps) {
    if (s.kind === 'dispatch') edges.push(branchEdge(s.id, 'respond', 'answered'));
  }
  return endpoint({
    id: 'token',
    label: 'Token endpoint',
    path: '/token',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.authorizationCode,
    spec: 'OIDC Core 1.0 §3.1.3',
    rearrangeable: true,
    steps,
    edges,
    errorStep: 'respond-error',
  });
}

function userinfoEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'parse-access-token',
      label: 'Read the Bearer token',
      kind: 'parse',
      spec: 'RFC 6750 §2.1 / §2.2',
      function: 'parseUserInfoRequest',
      produces: ['accessToken'],
    }),
    step({
      id: 'resolve-access-token',
      label: 'Resolve and validate the access token',
      kind: 'resolve',
      spec: 'OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4',
      function: 'resolveUserInfoToken',
      calls: [
        'resolveUserInfoAccessToken',
        'validateUserInfoTokenExpiration',
        'validateUserInfoScope',
        'validateUserInfoAudience',
      ],
      consumes: ['accessToken'],
      produces: ['tokenInfo'],
    }),
    step({
      id: 'resolve-claims',
      label: 'Resolve the claims the token may see',
      kind: 'resolve',
      spec: 'OIDC Core 1.0 §5.4 / §5.5',
      function: 'resolveUserInfoResponseClaims',
      calls: ['resolveUserInfoClaims', 'filterClaimsByScope', 'applyRequestedClaims'],
      consumes: ['tokenInfo'],
      produces: ['claims'],
    }),
    step({
      id: 'build-response',
      label: 'Build the response (JSON or signed JWT)',
      kind: 'transform',
      spec: 'OIDC Core 1.0 §5.3.2',
      function: 'buildUserInfoResponse',
      calls: ['selectSigningKeyByAlg', 'generateUserInfoJwt'],
      consumes: ['tokenInfo', 'claims'],
      produces: ['userInfoResponse'],
    }),
    step({
      id: 'respond',
      label: 'Respond (no-store)',
      kind: 'respond',
      spec: 'RFC 6750 §5.2',
      function: 'respondUserInfo',
      consumes: ['userInfoResponse'],
    }),
    step({
      id: 'respond-error',
      label: 'Respond with the Bearer challenge',
      kind: 'respond',
      spec: 'RFC 6750 §3',
      function: 'respondUserInfoError',
    }),
  ];
  return endpoint({
    id: 'userinfo',
    label: 'UserInfo endpoint',
    path: '/userinfo',
    methods: ['GET', 'POST'],
    layer: 'api',
    group: FLOW_GROUPS.authorizationCode,
    spec: 'OIDC Core 1.0 §5.3',
    rearrangeable: true,
    steps,
    edges: chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
    errorStep: 'respond-error',
  });
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

function introspectionEndpoint(features: OidcFeatureConfig): FlowEndpoint {
  const steps = enabledSteps(
    [
      step({
        id: 'parse-request',
        label: 'Parse the introspection request',
        kind: 'parse',
        spec: 'RFC 7662 §2.1',
        function: 'parseIntrospectionRequest',
        produces: ['params', 'authorization'],
      }),
      step({
        id: 'authenticate-client',
        label: 'Authenticate the confidential client',
        kind: 'validate',
        spec: 'RFC 7662 §2.1 / OAuth 2.1 §2.3',
        function: 'authenticateIntrospectionClient',
        calls: [
          'extractClientCredentials',
          'resolveAuthenticatedTokenClient',
          'validateClientAuthMethod',
          'verifyClientSecret',
          'requireConfidentialIntrospectionCaller',
        ],
        consumes: ['params', 'authorization'],
        produces: ['authenticatedClientId'],
      }),
      step({
        id: 'resolve-token',
        label: 'Resolve the presented token',
        kind: 'resolve',
        spec: 'RFC 7662 §2.1',
        function: 'resolveIntrospectedToken',
        calls: ['requireIntrospectionToken', 'requireIntrospectionClient', 'resolveIntrospectionToken'],
        consumes: ['params', 'authenticatedClientId'],
        produces: ['resolved'],
      }),
      step({
        id: 'build-response',
        label: 'Describe the token (active or not)',
        kind: 'transform',
        spec: 'RFC 7662 §2.2',
        function: 'describeIntrospectedToken',
        calls: ['isIntrospectionTokenActive', 'buildIntrospectionResponse'],
        consumes: ['resolved'],
        produces: ['introspection'],
      }),
      step({
        id: 'sign-response',
        label: 'Answer as a signed JWT when asked for one',
        kind: 'dispatch',
        spec: 'RFC 9701 §4 / §5',
        function: 'signIntrospectionResponse',
        calls: [
          'acceptsIntrospectionJwt',
          'restrictIntrospectionResponseToCaller',
          'selectSigningKeyByAlg',
          'createIntrospectionResponseJwt',
        ],
        consumes: ['introspection', 'authenticatedClientId'],
        feature: 'jwtIntrospectionResponse',
        after: ['build-response'],
      }),
      step({
        id: 'respond',
        label: 'Respond (no-store)',
        kind: 'respond',
        spec: 'RFC 7662 §2.2',
        function: 'respondIntrospection',
        consumes: ['introspection'],
      }),
      step({
        id: 'respond-error',
        label: 'Respond with the OAuth error',
        kind: 'respond',
        spec: 'RFC 7662 §2.3',
        function: 'respondIntrospectionError',
      }),
    ],
    features,
  );
  const ids = new Set(steps.map((s) => s.id));
  return endpoint({
    id: 'introspection',
    label: 'Token introspection endpoint',
    path: '/introspect',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.tokenManagement,
    spec: 'RFC 7662 §2',
    feature: 'introspection',
    rearrangeable: true,
    steps,
    edges: [
      ...chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
      ...edgesAmong([branchEdge('sign-response', 'respond', 'application/token-introspection+jwt')], ids),
    ],
    errorStep: 'respond-error',
  });
}

function revocationEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'parse-request',
      label: 'Parse the revocation request',
      kind: 'parse',
      spec: 'RFC 7009 §2.1',
      function: 'parseRevocationRequest',
      produces: ['params', 'authorization'],
    }),
    step({
      id: 'authenticate-client',
      label: 'Authenticate the client',
      kind: 'validate',
      spec: 'RFC 7009 §2.1 / OAuth 2.1 §2.3',
      function: 'authenticateRevocationClient',
      calls: [
        'extractClientCredentials',
        'resolveAuthenticatedTokenClient',
        'validateClientAuthMethod',
        'verifyClientSecret',
      ],
      consumes: ['params', 'authorization'],
      produces: ['authenticatedClientId'],
    }),
    step({
      id: 'resolve-token',
      label: 'Resolve the presented token',
      kind: 'resolve',
      spec: 'RFC 7009 §2.1',
      function: 'resolveRevocationTokenTarget',
      calls: ['requireRevocationToken', 'requireRevocationClient', 'resolveRevocationTarget'],
      consumes: ['params', 'authenticatedClientId'],
      produces: ['token', 'resolved'],
    }),
    step({
      id: 'revoke-token',
      label: 'Revoke the token and its grant siblings',
      kind: 'persist',
      spec: 'RFC 7009 §2.1',
      function: 'revokeToken',
      calls: ['validateRevocationTokenClient', 'revokeResolvedToken', 'revokeGrantAccessTokens'],
      consumes: ['token', 'resolved', 'authenticatedClientId'],
    }),
    step({
      id: 'respond',
      label: 'Respond 200 with an empty body',
      kind: 'respond',
      spec: 'RFC 7009 §2.2',
      function: 'respondRevocation',
    }),
    step({
      id: 'respond-error',
      label: 'Respond with the OAuth error',
      kind: 'respond',
      spec: 'RFC 7009 §2.2.1',
      function: 'respondRevocationError',
    }),
  ];
  return endpoint({
    id: 'revocation',
    label: 'Token revocation endpoint',
    path: '/revoke',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.tokenManagement,
    spec: 'RFC 7009 §2',
    feature: 'revocation',
    rearrangeable: true,
    steps,
    edges: chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
    errorStep: 'respond-error',
  });
}

// ---------------------------------------------------------------------------
// Experimental endpoints
// ---------------------------------------------------------------------------

function parEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'parse-request',
      label: 'Parse the pushed authorization request',
      kind: 'parse',
      spec: 'RFC 9126 §2.1 / RFC 6749 §3.1',
      function: 'parsePushedAuthorizationRequest',
      produces: ['params', 'authorization'],
    }),
    step({
      id: 'authenticate-client',
      label: 'Authenticate the pushing client',
      kind: 'validate',
      spec: 'RFC 9126 §2.1',
      function: 'authenticatePushingClient',
      calls: ['rejectForbiddenParParams', 'authenticateParClient'],
      consumes: ['params', 'authorization'],
      produces: ['clientId', 'pushedParams'],
    }),
    step({
      id: 'validate-request',
      label: 'Validate the request as /authorize would',
      kind: 'validate',
      spec: 'RFC 9126 §2.1',
      function: 'validatePushedRequest',
      calls: ['validatePushedAuthorizationParams'],
      consumes: ['pushedParams'],
    }),
    step({
      id: 'store-request',
      label: 'Store the request under a fresh request_uri',
      kind: 'persist',
      spec: 'RFC 9126 §2.2 / §7.1',
      function: 'storePushedRequest',
      calls: ['createPushedAuthorizationRecord', 'buildPushedAuthorizationResponse'],
      consumes: ['clientId', 'pushedParams'],
      produces: ['parResponse'],
    }),
    step({
      id: 'respond',
      label: 'Respond 201 (no-store)',
      kind: 'respond',
      spec: 'RFC 9126 §2.2',
      function: 'respondPar',
      consumes: ['parResponse'],
    }),
    step({
      id: 'respond-error',
      label: 'Respond with the OAuth error',
      kind: 'respond',
      spec: 'RFC 9126 §2.3',
      function: 'respondParError',
    }),
  ];
  return endpoint({
    id: 'par',
    label: 'Pushed authorization request endpoint',
    path: '/par',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.pushedAuthorization,
    spec: 'RFC 9126 §2',
    feature: 'par',
    rearrangeable: true,
    steps,
    edges: chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
    errorStep: 'respond-error',
  });
}

function registerEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'verify-initial-access-token',
      label: 'Check the initial access token, if one is required',
      kind: 'validate',
      spec: 'OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1',
      function: 'verifyRegistrationAccess',
      calls: ['verifyInitialAccessToken'],
    }),
    step({
      id: 'parse-request',
      label: 'Read the JSON metadata',
      kind: 'parse',
      spec: 'RFC 7591 §3.1',
      function: 'parseRegistrationRequest',
      produces: ['rawBody'],
    }),
    step({
      id: 'validate-metadata',
      label: 'Validate the metadata and build the client',
      kind: 'validate',
      spec: 'RFC 7591 §2 / §3.1',
      function: 'validateRegistrationMetadata',
      calls: ['validateClientRegistrationRequest', 'buildRegisteredClient'],
      consumes: ['rawBody'],
      produces: ['client'],
    }),
    step({
      id: 'store-client',
      label: 'Enforce the inventory cap and store the client',
      kind: 'persist',
      spec: 'RFC 7591 §5',
      function: 'storeRegisteredClient',
      consumes: ['client'],
    }),
    step({
      id: 'respond',
      label: 'Respond 201 with the registration response',
      kind: 'respond',
      spec: 'RFC 7591 §3.2.1',
      function: 'respondRegistration',
      calls: ['buildClientRegistrationResponse'],
      consumes: ['client'],
    }),
    step({
      id: 'respond-error',
      label: 'Respond with the registration error',
      kind: 'respond',
      spec: 'RFC 7591 §3.2.2',
      function: 'respondRegistrationError',
    }),
  ];
  return endpoint({
    id: 'register',
    label: 'Client registration endpoint',
    path: '/register',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.clientRegistration,
    spec: 'RFC 7591 §3',
    feature: 'dynamicClientRegistration',
    rearrangeable: true,
    steps,
    edges: chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
    errorStep: 'respond-error',
  });
}

function deviceAuthorizationEndpoint(customScopes: boolean): FlowEndpoint {
  const steps = [
    step({
      id: 'parse-request',
      label: 'Parse the device authorization request',
      kind: 'parse',
      spec: 'RFC 8628 §3.1',
      function: 'parseDeviceAuthorizationRequest',
      produces: ['params', 'authorization'],
    }),
    step({
      id: 'authenticate-client',
      label: 'Authenticate the client',
      kind: 'validate',
      spec: 'RFC 8628 §3.1 / RFC 6749 §3.2.1',
      function: 'authenticateDeviceClient',
      calls: [
        'extractClientCredentials',
        'resolveAuthenticatedTokenClient',
        'validateClientAuthMethod',
        'verifyClientSecret',
      ],
      consumes: ['params', 'authorization'],
      produces: ['client'],
    }),
    step({
      id: 'validate-request',
      label: 'Validate the grant registration and the scope',
      kind: 'validate',
      spec: 'RFC 8628 §3.1 / RFC 7591 §2 / OIDC Core 1.0 §11',
      function: 'validateDeviceAuthorizationRequest',
      calls: [
        'validateDeviceGrantAllowed',
        'validateDeviceAuthorizationScope',
        'findUnregisteredClientScopes',
        'applyOfflineAccessPolicy',
        ...(customScopes ? ['findUnsupportedScopes'] : []),
      ],
      consumes: ['params', 'client'],
      produces: ['scope'],
    }),
    step({
      id: 'issue-device-code',
      label: 'Mint the device_code and user_code',
      kind: 'issue',
      spec: 'RFC 8628 §3.2 / §5.2',
      function: 'issueDeviceCodes',
      calls: ['createDeviceAuthorizationRecord'],
      consumes: ['client', 'scope'],
      produces: ['record'],
    }),
    step({
      id: 'respond',
      label: 'Respond with the device authorization response (no-store)',
      kind: 'respond',
      spec: 'RFC 8628 §3.2',
      function: 'respondDeviceAuthorization',
      calls: ['buildDeviceAuthorizationResponse'],
      consumes: ['record'],
    }),
    step({
      id: 'respond-error',
      label: 'Respond with the OAuth error',
      kind: 'respond',
      spec: 'RFC 6749 §5.2',
      function: 'respondDeviceAuthorizationError',
    }),
  ];
  return endpoint({
    id: 'device-authorization',
    label: 'Device authorization endpoint',
    path: '/device_authorization',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.deviceAuthorization,
    spec: 'RFC 8628 §3.1 / §3.2',
    feature: 'deviceAuthorizationGrant',
    rearrangeable: true,
    steps,
    edges: chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
    errorStep: 'respond-error',
  });
}

function deviceVerificationEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'submit-user-code',
      label: 'Match the user_code and bind this browser',
      kind: 'resolve',
      spec: 'RFC 8628 §3.3',
      function: 'submitDeviceUserCode',
      calls: ['findPendingRecordByUserCode', 'issueVerificationBinding', 'buildDeviceBindingCookie'],
      produces: ['record', 'bindingCookie'],
    }),
    step({
      id: 'submit-login',
      label: 'Sign the End-User in on this browser',
      kind: 'validate',
      spec: 'RFC 8628 §3.3',
      function: 'submitDeviceLogin',
      calls: [
        'findPendingRecordByUserCode',
        'validateVerificationBinding',
        'validateVerificationCsrfToken',
        'recordDeviceLoginFailure',
        'buildSessionCookie',
      ],
      consumes: ['record', 'bindingCookie'],
      produces: ['session'],
    }),
    step({
      id: 'submit-decision',
      label: 'Approve or deny the device',
      kind: 'persist',
      spec: 'RFC 8628 §3.3',
      function: 'submitDeviceDecision',
      calls: [
        'findPendingRecordByUserCode',
        'validateVerificationBinding',
        'approveDeviceAuthorization',
        'denyDeviceAuthorization',
        'consentResolver.recordConsent',
        'consentResolver.recordGrant',
      ],
      consumes: ['record', 'bindingCookie', 'session'],
    }),
  ];
  return endpoint({
    id: 'device',
    label: 'Device verification screens',
    path: '/device',
    methods: ['GET', 'POST'],
    layer: 'browser',
    group: FLOW_GROUPS.deviceAuthorization,
    spec: 'RFC 8628 §3.3',
    feature: 'deviceAuthorizationGrant',
    rearrangeable: false,
    steps,
    edges: [
      branchEdge('submit-user-code', 'submit-login', 'no OP session'),
      branchEdge('submit-user-code', 'submit-decision', 'OP session'),
      flowEdge('submit-login', 'submit-decision'),
    ],
  });
}

function backchannelAuthenticationEndpoint(customScopes: boolean): FlowEndpoint {
  const steps = [
    step({
      id: 'parse-request',
      label: 'Parse the backchannel authentication request',
      kind: 'parse',
      spec: 'CIBA Core 1.0 §7.1',
      function: 'parseBackchannelAuthenticationRequest',
      produces: ['params', 'authorization'],
    }),
    step({
      id: 'authenticate-client',
      label: 'Authenticate the client',
      kind: 'validate',
      spec: 'CIBA Core 1.0 §7.1',
      function: 'authenticateCibaClient',
      calls: [
        'extractClientCredentials',
        'resolveAuthenticatedTokenClient',
        'validateClientAuthMethod',
        'verifyClientSecret',
      ],
      consumes: ['params', 'authorization'],
      produces: ['client'],
    }),
    step({
      id: 'validate-client-scope',
      label: 'Check the requested scope against the registration',
      kind: 'validate',
      spec: 'RFC 7591 §2 / RFC 6749 §3.3',
      function: 'validateCibaClientScope',
      calls: [...(customScopes ? ['findUnsupportedScopes'] : []), 'findUnregisteredClientScopes'],
      consumes: ['params', 'client'],
    }),
    step({
      id: 'create-request',
      label: 'Resolve the login_hint and create the pending request',
      kind: 'issue',
      spec: 'CIBA Core 1.0 §7.1 - §7.3',
      function: 'createBackchannelAuthenticationRequest',
      calls: ['processBackchannelAuthenticationRequest'],
      consumes: ['params', 'client'],
      produces: ['cibaResponse'],
    }),
    step({
      id: 'respond',
      label: 'Respond with auth_req_id (no-store)',
      kind: 'respond',
      spec: 'CIBA Core 1.0 §7.3',
      function: 'respondBackchannelAuthentication',
      consumes: ['cibaResponse'],
    }),
    step({
      id: 'respond-error',
      label: 'Respond with the OAuth error',
      kind: 'respond',
      spec: 'CIBA Core 1.0 §13',
      function: 'respondBackchannelAuthenticationError',
    }),
  ];
  return endpoint({
    id: 'backchannel-authentication',
    label: 'Backchannel authentication endpoint',
    path: '/backchannel_authentication',
    methods: ['POST'],
    layer: 'api',
    group: FLOW_GROUPS.backchannelAuthentication,
    spec: 'CIBA Core 1.0 §7',
    feature: 'ciba',
    rearrangeable: true,
    steps,
    edges: chain(steps.filter((s) => s.id !== 'respond-error').map((s) => s.id)),
    errorStep: 'respond-error',
  });
}

function cibaVerificationEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'prepare-device',
      label: 'List pending requests, or start a login transaction',
      kind: 'resolve',
      function: 'prepareCibaDevice',
      calls: ['listPendingCibaRequests', 'createCibaLoginTransaction', 'buildCibaLoginBindingCookie'],
      produces: ['loginTransaction'],
    }),
    step({
      id: 'submit-login',
      label: 'Sign the End-User in on this browser',
      kind: 'validate',
      function: 'submitCibaLogin',
      calls: ['validateCibaLoginSubmission', 'recordCibaLoginFailure', 'buildSessionCookie'],
      consumes: ['loginTransaction'],
      produces: ['session'],
    }),
    step({
      id: 'submit-decision',
      label: 'Approve or deny a pending request',
      kind: 'persist',
      spec: 'CIBA Core 1.0 §7.1 (authentication device)',
      function: 'submitCibaDecision',
      calls: [
        'approveCibaRequest',
        'denyCibaRequest',
        'consentResolver.recordConsent',
        'consentResolver.recordGrant',
      ],
      consumes: ['session'],
    }),
  ];
  return endpoint({
    id: 'ciba',
    label: 'CIBA authentication device screens',
    path: '/ciba',
    methods: ['GET', 'POST'],
    layer: 'browser',
    group: FLOW_GROUPS.backchannelAuthentication,
    spec: 'CIBA Core 1.0 §7.1',
    feature: 'ciba',
    rearrangeable: false,
    steps,
    edges: [
      branchEdge('prepare-device', 'submit-login', 'no OP session'),
      branchEdge('prepare-device', 'submit-decision', 'OP session'),
      flowEdge('submit-login', 'submit-decision'),
    ],
  });
}

function logoutEndpoint(): FlowEndpoint {
  const steps = [
    step({
      id: 'process-end-session-request',
      label: 'Verify id_token_hint and decide: log out or confirm',
      kind: 'decide',
      spec: 'RP-Initiated Logout 1.0 §2 / §3',
      function: 'processEndSessionRequest',
      calls: [
        'parseEndSessionRequest',
        'extractIdTokenHintAudience',
        'validateIdTokenHint',
        'decideLogoutFlow',
        'resolvePostLogoutRedirect',
      ],
      produces: ['confirmation'],
    }),
    step({
      id: 'approve-logout',
      label: 'Confirmed: end the session',
      kind: 'persist',
      spec: 'RP-Initiated Logout 1.0 §2',
      function: 'approveLogout',
      calls: ['parseLogoutConfirmation', 'buildClearedSessionCookie'],
      consumes: ['confirmation'],
    }),
  ];
  return endpoint({
    id: 'logout',
    label: 'End session endpoint',
    path: '/logout',
    methods: ['GET', 'POST'],
    layer: 'browser',
    group: FLOW_GROUPS.logout,
    spec: 'RP-Initiated Logout 1.0 §2',
    feature: 'rpInitiatedLogout',
    rearrangeable: false,
    steps,
    edges: [branchEdge('process-end-session-request', 'approve-logout', 'confirmation screen')],
  });
}

// ---------------------------------------------------------------------------
// The whole OP
// ---------------------------------------------------------------------------

/** How a client or a browser travels between the endpoints. */
function journeyEdges(ids: ReadonlySet<string>): FlowEdge[] {
  return edgesAmong(
    [
      flowEdge('par', 'authorize', 'request_uri'),
      flowEdge('register', 'authorize', 'client_id'),
      flowEdge('authorize', 'login', 'login required'),
      flowEdge('authorize', 'consent', 'SSO: consent required'),
      flowEdge('authorize', 'token', 'code (prompt=none / SSO)'),
      flowEdge('login', 'login-google', 'Sign in with Google'),
      flowEdge('login-google', 'consent', 'authenticated'),
      flowEdge('login', 'consent', 'authenticated'),
      flowEdge('consent', 'token', 'code'),
      flowEdge('token', 'userinfo', 'access_token'),
      flowEdge('token', 'introspection', 'token'),
      flowEdge('token', 'revocation', 'token'),
      flowEdge('device-authorization', 'device', 'user_code (End-User)'),
      flowEdge('device-authorization', 'token', 'device_code (polling)'),
      flowEdge('backchannel-authentication', 'ciba', 'End-User approves'),
      flowEdge('backchannel-authentication', 'token', 'auth_req_id (polling)'),
      flowEdge('token', 'logout', 'id_token_hint'),
    ],
    ids,
  );
}

/**
 * Build the OpFlow of a generation: the endpoints the features produce, in the
 * order the generated app mounts them, with their steps and arrows.
 */
export function buildOpFlow(options: BuildOpFlowOptions): OpFlow {
  const { features } = options;
  const scopes = options.scopes ?? [];
  const customScopes = scopes.length > 0;
  const endpoints: FlowEndpoint[] = [
    discoveryEndpoint(features),
    jwksEndpoint(),
    authorizeEndpoint(features, customScopes),
    loginEndpoint(features),
    ...(features.googleLogin ? [googleLoginEndpoint()] : []),
    consentEndpoint(features, customScopes),
    tokenEndpoint(features),
    userinfoEndpoint(),
    ...(features.introspection ? [introspectionEndpoint(features)] : []),
    ...(features.revocation ? [revocationEndpoint()] : []),
    ...(features.par ? [parEndpoint()] : []),
    ...(features.dynamicClientRegistration ? [registerEndpoint()] : []),
    ...(features.deviceAuthorizationGrant
      ? [deviceAuthorizationEndpoint(customScopes), deviceVerificationEndpoint()]
      : []),
    ...(features.ciba ? [backchannelAuthenticationEndpoint(customScopes), cibaVerificationEndpoint()] : []),
    ...(features.rpInitiatedLogout ? [logoutEndpoint()] : []),
  ];
  const ids = new Set(endpoints.map((e) => e.id));
  return {
    version: 1,
    features: { ...features },
    scopes: [...scopes],
    db: options.db ?? null,
    endpoints,
    edges: journeyEdges(ids),
  };
}

/** The step kinds, in the order the legend of a diagram lists them. */
export const FLOW_STEP_KINDS: readonly FlowStepKind[] = [
  'parse',
  'resolve',
  'validate',
  'decide',
  'dispatch',
  'issue',
  'persist',
  'transform',
  'respond',
];
